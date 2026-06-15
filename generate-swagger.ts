#!/usr/bin/env node
/**
 * generate-swagger.ts
 *
 * Usage:
 *   npx ts-node generate-swagger.ts
 *   BASE_URL="https://api.example.com" npx ts-node generate-swagger.ts
 *
 * Behavior:
 * - Walks ./routes (configurable by ROUTES_DIR env var)
 * - Parses route files looking for router.<method>(path, ...middlewares, handler)
 * - Detects validate(validatorX, { body: true, query: true, params: true }) usages and loads the referenced Joi validators
 * - Extracts Joi types via schema.describe()
 * - Detects validateAccess(...) middleware to add bearerAuth security to that operation
 * - Writes ./swagger.yaml (overwrites)
 *
 * Notes:
 * - Assumes route files export default a function that calls app.use("/basepath", router)
 *   (common pattern: export default (app) => app.use("/messages", router);)
 * - Assumes validators are CommonJS/ES module exports of Joi schemas (e.g., export const sendMessage = Joi.object(...))
 * - If a validator is dynamic or created in an unusual way, it may not be discovered automatically
 */

import fs from "fs";
import path from "path";
import { glob } from "glob";
import * as parser from "@babel/parser";
import traverse from "@babel/traverse";
import yaml from "js-yaml";

const ROUTES_DIR = process.env.ROUTES_DIR || path.join(process.cwd(), "src/routes/v1");
const OUT_FILE = path.join(process.cwd(), "swagger.yaml");
const SERVER_URL = process.env.BASE_URL || "https://backend.auxhr.com/v1";
console.log(SERVER_URL);

// Type definitions
interface JoiDescribe {
  type?: string;
  flags?: {
    integer?: boolean;
    presence?: string;
    description?: string;
    default?: any;
    nullable?: boolean;
  };
  allow?: any[];
  items?: JoiDescribe[];
  keys?: { [key: string]: JoiDescribe };
  valids?: any[];
}

interface ValidateInfo {
  validatorVar: string | null;
  validatorMember: string | null;
  options: {
    body?: boolean;
    query?: boolean;
    params?: boolean;
  };
}

interface FileUploadInfo {
  type: "single" | "fields";
  fieldName?: string;
  fields?: { name: string; maxCount: number }[];
}

interface RouteInfo {
  method: string;
  path: string;
  middlewares: string[];
  validateInfo: ValidateInfo | null;
  hasValidateAccess: boolean;
  file: string;
  tags: string[];
  fileUploadInfo?: FileUploadInfo;
}

interface ImportMap {
  [key: string]: string;
}

interface ExtractResult {
  importMap: ImportMap;
  routes: RouteInfo[];
  baseGroup: string | null;
}

interface OpenAPIOperation {
  summary: string;
  tags: string[];
  parameters: any[];
  responses: {
    [key: string]: {
      description: string;
      content: {
        "application/json": {
          schema: any;
        };
      };
    };
  };
  requestBody?: any;
  security?: any[];
}

interface OpenAPIPaths {
  [key: string]: {
    [method: string]: OpenAPIOperation;
  };
}

interface OpenAPIComponents {
  securitySchemes: {
    bearerAuth: {
      type: string;
      scheme: string;
      bearerFormat: string;
    };
  };
  schemas: {
    [key: string]: any;
  };
}

interface OpenAPIDocument {
  openapi: string;
  info: {
    title: string;
    description: string;
    version: string;
  };
  servers: Array<{ url: string }>;
  components: OpenAPIComponents;
  paths: OpenAPIPaths;
}

/**
 * Helpers to load a module path which may be ES module or CommonJS.
 * We try requiring it directly; if that fails because of ESM default exports,
 * we attempt to read .default (works for transpiled code).
 */
function safeRequire(filePath: string): any {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- module path is dynamic, computed at runtime
    const required = require(filePath);
    return required && required.__esModule && required.default ? required.default : required;
  } catch (err: any) {
    // If require fails for ESM because Node cannot load it, attempt to read transpiled
    // or use Babel or fallback to reading as text (but we try to require as best effort).
    // For now, surface the error for clarity.
    throw new Error(`Failed to require validator module at ${filePath}: ${err.message}`, {
      cause: err,
    });
  }
}

/**
 * Map Joi.describe() type to OpenAPI type/format
 */
function joiTypeToOpenApi(desc: JoiDescribe | null): {
  type: string;
  format?: string;
  items?: any;
} {
  const t = (desc && desc.type) || "object";
  switch (t) {
    case "string":
      return { type: "string" };
    case "number":
      // Joi has integer flag sometimes
      if (desc && desc.flags && desc.flags.integer) return { type: "integer" };
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "array": {
      // try item type
      const items =
        desc && desc.items && desc.items[0] ? joiTypeToOpenApi(desc.items[0]) : { type: "string" };
      return { type: "array", items };
    }
    case "date":
      return { type: "string", format: "date-time" };
    case "object":
    default:
      return { type: "object" };
  }
}

/**
 * Build an OpenAPI schema (plain object) from Joi.describe()
 */
function buildSchemaFromJoiDescribe(desc: JoiDescribe | null): any {
  if (!desc) return {};
  const type = desc.type || "object";
  if (type === "object") {
    const props: { [key: string]: any } = {};
    const required: string[] = [];
    const children = desc.keys || {};
    Object.entries(children).forEach(([key, childDesc]) => {
      const childSchema = buildSchemaFromJoiDescribe(childDesc);
      props[key] = childSchema;
      if (childDesc.flags && childDesc.flags.presence === "required") required.push(key);
    });
    const schema: any = { type: "object" };
    if (Object.keys(props).length) schema.properties = props;
    if (required.length) schema.required = required;
    return schema;
  } else if (type === "array") {
    const itemsDesc = (desc.items && desc.items[0]) || null;
    return { type: "array", items: buildSchemaFromJoiDescribe(itemsDesc) || { type: "string" } };
  } else {
    const primitive = joiTypeToOpenApi(desc);
    // Add enum if present
    if (desc.allow && Array.isArray(desc.allow) && desc.allow.length > 0) {
      // Joi uses allow([...]) to permit values; describe() shows them in `valids` for some versions
      const enumer = desc.allow.filter(
        (v) => v !== undefined && !(v === null && !desc.flags?.nullable)
      );
      if (enumer.length) (primitive as any).enum = enumer;
    }
    if (desc.flags && desc.flags.default !== undefined)
      (primitive as any).default = desc.flags.default;
    return primitive;
  }
}

/**
 * Read Joi schema object from required validator module.
 * `mod` is the module object; `exportName` is the property (e.g., 'sendMessage').
 * We call .describe() on the Joi schema to get detailed metadata.
 */
function joiSchemaDescribeFromModule(mod: any, exportName: string): JoiDescribe | null {
  if (!mod) return null;
  const schema =
    mod[exportName] || mod[exportName + "Schema"] || (mod.default && mod.default[exportName]);
  if (!schema) return null;
  if (typeof schema.describe !== "function") {
    // If it's wrapped, attempt to access .schema property
    if (
      schema &&
      typeof schema === "object" &&
      typeof schema._inner === "object" &&
      typeof schema.describe === "function"
    ) {
      // still try
    } else {
      return null;
    }
  }
  try {
    return schema.describe();
  } catch {
    // maybe the schema is a function that returns Joi object
    try {
      const maybe = typeof schema === "function" ? schema() : schema;
      if (maybe && typeof maybe.describe === "function") return maybe.describe();
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Find route files
 */
function findRouteFiles(dir: string): string[] {
  const pattern = path.join(dir, "**/*.[tj]s"); // ts or js
  return glob.sync(pattern, { nodir: true });
}

/**
 * Parse a file to AST
 */
function parseToAst(contents: string, filename: string): any {
  return parser.parse(contents, {
    sourceType: "module",
    plugins: [
      "jsx",
      "classProperties",
      "objectRestSpread",
      "optionalChaining",
      "nullishCoalescingOperator",
      "decorators-legacy",
      // TypeScript could be present
      filename.endsWith(".ts") || filename.endsWith(".tsx") ? "typescript" : null,
    ].filter(Boolean) as any[],
  });
}

/**
 * Generate a short textual representation for a Node (best-effort)
 */
function generateTextForNode(node: any): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (node.type === "Identifier") return node.name;
  if (node.type === "CallExpression") {
    if (node.callee.type === "Identifier") {
      return node.callee.name + "(...)";
    } else if (node.callee.type === "MemberExpression") {
      const obj =
        (node.callee.object &&
          (node.callee.object.name ||
            (node.callee.object.object && node.callee.object.object.name))) ||
        "obj";
      const prop =
        (node.callee.property && (node.callee.property.name || node.callee.property.value)) || "fn";
      return `${obj}.${prop}(...)`;
    }
  }
  return node.type;
}

/**
 * Walk a router AST and extract route definitions and import map
 */
function extractRoutesFromFile(filepath: string): ExtractResult {
  const raw = fs.readFileSync(filepath, "utf8");
  const currentMiddlewares: any[] = [];
  const ast = parseToAst(raw, filepath);
  const importMap: ImportMap = {}; // localName -> source path (raw import string)
  const routes: RouteInfo[] = []; // { method, path, middlewares: [string node text], validateInfo: {validatorVar, validatorMember, options}, hasValidateAccess, file }
  let baseGroup: string | null = null;

  traverse(ast, {
    ImportDeclaration(pathNode: any) {
      const src = pathNode.node.source.value;
      pathNode.node.specifiers.forEach((s: any) => {
        if (s.type === "ImportNamespaceSpecifier") {
          importMap[s.local.name] = src;
        } else if (s.type === "ImportDefaultSpecifier") {
          importMap[s.local.name] = src;
        } else if (s.type === "ImportSpecifier") {
          importMap[s.local.name] = src;
        }
      });
    },

    // Find export default (app) => app.use("/messages", router)
    ExportDefaultDeclaration(pathNode: any) {
      const decl = pathNode.node.declaration;

      // Handle different types of exports
      if (decl.type === "CallExpression") {
        // export default router
        return;
      }

      if (decl.type === "ArrowFunctionExpression" || decl.type === "FunctionExpression") {
        // Look for app.use("/basepath", router) pattern
        const body = decl.body;
        if (body.type === "BlockStatement") {
          // Look in block statements
          body.body.forEach((stmt: any) => {
            if (stmt.type === "ExpressionStatement" && stmt.expression.type === "CallExpression") {
              const callExpr = stmt.expression;
              const callee = callExpr.callee;
              if (
                callee.type === "MemberExpression" &&
                callee.property.name === "use" &&
                callExpr.arguments.length >= 1
              ) {
                const firstArg = callExpr.arguments[0];
                if (firstArg.type === "StringLiteral") {
                  baseGroup = firstArg.value;
                }
              }
            }
          });
        } else if (body.type === "CallExpression") {
          // Handle arrow functions with direct call: (app) => app.use("/base", router)
          const callee = body.callee;
          if (
            callee.type === "MemberExpression" &&
            callee.property.name === "use" &&
            body.arguments.length >= 1
          ) {
            const firstArg = body.arguments[0];
            if (firstArg.type === "StringLiteral") {
              baseGroup = firstArg.value;
            }
          }
        }
      }
    },

    // Find router.<method> calls
    CallExpression(pathNode: any) {
      const callee = pathNode.node.callee;
      if (!callee || callee.type !== "MemberExpression") return;
      if (!callee.object || !callee.object.name) return;
      if (callee.object.name !== "router") return;
      const method = callee.property && (callee.property.name || callee.property.value); // get "get","post" ...
      if (!method) return;
      const args = pathNode.node.arguments || [];
      if (args.length === 0) return;

      if (method == "use") {
        for (let i = 0; i < args.length; i++) {
          const a = args[i];
          currentMiddlewares.push(a);
        }
        return;
      }

      // for (let i = 0; i < args.length; i++) {
      //     const a = args[i];
      //     console.log(a)
      //   }

      // first arg is path - if not string literal, skip
      const firstArg = args[0];
      let routePath: string;
      if (firstArg.type === "StringLiteral" || firstArg.type === "Literal") {
        routePath = firstArg.value;
      } else if (
        firstArg.type === "TemplateLiteral" &&
        firstArg.quasis &&
        firstArg.quasis.length === 1
      ) {
        routePath = firstArg.quasis[0].value.cooked;
      } else {
        // skip dynamic route path
        return;
      }
      // remaining args are middlewares and handler
      const middlewares: string[] = currentMiddlewares;
      const validateInfo: ValidateInfo | null = null;
      const hasValidateAccess = false;
      const otherTags: string[] = [];

      routes.push({
        method: method.toLowerCase(),
        path: routePath,
        middlewares,
        validateInfo,
        hasValidateAccess,
        file: filepath,
        tags: otherTags,
      });

      const currentRoute = routes.length > 0 ? routes[routes.length - 1] : null;

      for (let i = 1; i < args.length; i++) {
        const a = args[i];
        // If it's a CallExpression of validate(...)
        if (a.type === "CallExpression" && a.callee && a.callee.name === "validate") {
          // validate(firstArg, secondArg)
          const vArg = a.arguments[0];
          const optionsArg = a.arguments[1];
          let validatorVar: string | null = null;
          let validatorMember: string | null = null;
          if (vArg) {
            if (vArg.type === "MemberExpression") {
              // validator.sendMessage
              validatorVar = vArg.object && vArg.object.name;
              validatorMember = vArg.property && (vArg.property.name || vArg.property.value);
            } else if (vArg.type === "Identifier") {
              // validate(someValidator)
              validatorVar = vArg.name;
            }
          }
          const options: any = {};
          if (optionsArg && optionsArg.type === "ObjectExpression") {
            optionsArg.properties.forEach((p: any) => {
              if (p.key && (p.key.name || p.key.value)) {
                const keyName = p.key.name || p.key.value;
                if (p.value && (p.value.type === "BooleanLiteral" || p.value.type === "Boolean")) {
                  options[keyName] = p.value.value === undefined ? p.value.value : p.value.value;
                } else if (p.value && p.value.type === "ObjectExpression") {
                  // skip nested for now
                } else if (p.value && p.value.type === "Identifier") {
                  // e.g., { body: true } usually boolean literal; fallback
                  options[keyName] = p.value.name === "true";
                }
              }
            });
          }
          if (currentRoute) {
            currentRoute.validateInfo = { validatorVar, validatorMember, options };
          }
        }

        // Detect multer uploads
        if (a.type === "CallExpression" && a.callee.type === "MemberExpression") {
          const callee = a.callee;
          if (
            callee.object.type === "MemberExpression" &&
            callee.object.object.name === "multerUploads" &&
            (callee.object.property.name === "memoryUpload" ||
              callee.object.property.name === "diskUpload")
          ) {
            if (
              callee.property.name === "single" &&
              a.arguments.length > 0 &&
              a.arguments[0].type === "StringLiteral"
            ) {
              if (currentRoute) {
                currentRoute.fileUploadInfo = {
                  type: "single",
                  fieldName: a.arguments[0].value,
                };
              }
            } else if (
              callee.property.name === "fields" &&
              a.arguments.length > 0 &&
              a.arguments[0].type === "ArrayExpression"
            ) {
              const fields = a.arguments[0].elements.map((el: any) => {
                const nameProp = el.properties.find((p: any) => p.key.name === "name");
                const maxCountProp = el.properties.find((p: any) => p.key.name === "maxCount");
                return {
                  name: nameProp ? nameProp.value.value : "unknown",
                  maxCount: maxCountProp ? maxCountProp.value.value : 1,
                };
              });
              if (currentRoute) {
                currentRoute.fileUploadInfo = { type: "fields", fields };
              }
            }
          }
        }

        // If it's a CallExpression of validateAccess(...)
        if (
          (a.type === "CallExpression" && a.callee && a.callee.name === "validateAccess") ||
          (a.type === "Identifier" && a.name === "loginRequired")
        ) {
          if (currentRoute) {
            currentRoute.hasValidateAccess = true;
          }
        }

        if (a.type === "CallExpression" && a.callee && a.callee.name === "validateAccess") {
          for (let i = 0; a.arguments[0].elements[i]; i++) {
            if (currentRoute) {
              currentRoute.tags.push(a.arguments[0].elements[i].property.name);
            }
          }
        }

        // Handle custom validators for scout route
        if (filepath.endsWith("scout.ts")) {
          const hasValidateCv = middlewares.includes("validateCv");
          const hasValidateCvAndCoverLetter = middlewares.includes("validateCvAndCoverLetter");

          if (hasValidateCv || hasValidateCvAndCoverLetter) {
            const properties: { [key: string]: any } = {};
            if (hasValidateCv) {
              properties["cv"] = { type: "string", format: "binary" };
            }

            if (hasValidateCvAndCoverLetter) {
              properties["cv"] = { type: "string", format: "binary" };
              properties["coverLetter"] = { type: "string", format: "binary" };
            }

            //console.log("before ==========================================>");
            const resolved = resolveImportToFile("src/middlewares/v1/validators/scout", filepath);
            //console.log(resolved)
            if (resolved) {
              let mod;
              try {
                mod = safeRequire(resolved);
              } catch (err: any) {
                console.warn(
                  `Warning: cannot require validator module ${resolved}: ${err.message}`
                );
                mod = null;
              }
              if (mod) {
                const joiDescribe = joiSchemaDescribeFromModule(mod, "schema");
                if (joiDescribe) {
                  const schema = buildSchemaFromJoiDescribe(joiDescribe);
                  //console.log(schema);
                  if (schema.properties) {
                    for (const key in schema.properties) {
                      properties[key] = schema.properties[key];
                    }
                  }
                }
              }
            }

            if (currentRoute) {
              currentRoute.fileUploadInfo = {
                type: "fields",
                fields: Object.keys(properties).map((p) => ({ name: p, maxCount: 1 })),
              };
            }
          }
        }

        // record textual middleware for debugging (optional)
        try {
          if (currentRoute) {
            currentRoute.middlewares.push(generateTextForNode(a));
          }
        } catch {
          if (currentRoute) {
            currentRoute.middlewares.push("<middleware>");
          }
        }
      }

      for (const a of currentMiddlewares) {
        if (
          (a.type === "CallExpression" && a.callee && a.callee.name === "validateAccess") ||
          (a.type === "Identifier" && a.name === "loginRequired")
        ) {
          if (currentRoute) {
            currentRoute.hasValidateAccess = true;
          }
        }
        if (a.type === "CallExpression" && a.callee && a.callee.name === "validateAccess") {
          for (let i = 0; a.arguments[0].elements[i]; i++) {
            if (currentRoute) {
              currentRoute.tags.push(a.arguments[0].elements[i].property.name);
            }
          }
        }
      }
    },
  } as any);

  return { importMap, routes, baseGroup };
}

/**
 * Resolve import source to actual file path to require the validator module.
 * importSource is as written in the import declaration (e.g., '../../middlewares/v1/validators/message')
 * baseFile is the file that imported it (for relative resolution).
 */
function resolveImportToFile(importSource: string, baseFile: string): string | null {
  if (!importSource) return null;
  if (importSource.startsWith(".")) {
    // relative path
    const resolved = path.resolve(path.dirname(baseFile), importSource);
    // try several extensions
    const candidates = [
      resolved + ".js",
      resolved + ".ts",
      resolved + ".cjs",
      resolved + "/index.js",
      resolved + "/index.ts",
      resolved,
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    // maybe it's already .js-less path that exists
    if (fs.existsSync(resolved)) return resolved;
    return null;
  } else {
    // absolute module - try to resolve from node_modules
    try {
      return require.resolve(importSource, { paths: [process.cwd()] });
    } catch {
      return null;
    }
  }
}

/**
 * Build OpenAPI parameter objects (path/query) from Joi describe
 */
function buildParametersFromJoi(desc: JoiDescribe | null, location: "query" | "path"): any[] {
  // desc is Joi.describe() result for an object which has keys
  if (!desc) return [];
  if (desc.type !== "object") return [];
  const keys = desc.keys || {};
  const params = [];
  for (const [name, child] of Object.entries(keys)) {
    const param = {
      name,
      in: location,
      required: (child.flags && child.flags.presence === "required") || location === "path",
      schema: buildSchemaFromJoiDescribe(child),
      description: child.flags && child.flags.description ? child.flags.description : undefined,
    };
    // If it's integer type we may add format
    params.push(param);
  }
  return params;
}

/**
 * Build request body OpenAPI object from Joi describe
 */
function buildRequestBodyFromJoi(desc: JoiDescribe | null): any {
  if (!desc) return null;
  // If the validator describes body as an object: desc = { type: 'object', keys: {...} }
  const schema = buildSchemaFromJoiDescribe(desc);
  return {
    required: true,
    content: {
      "application/json": {
        schema,
      },
    },
  };
}

/**
 * Main: iterate route files, extract routes and validator info, assemble openapi object
 */
function main(): void {
  const files = findRouteFiles(ROUTES_DIR);
  if (!files || files.length === 0) {
    console.error(`No route files found under ${ROUTES_DIR}. Exiting.`);
    process.exit(1);
  }

  const operationsByGroup: { [key: string]: OpenAPIPaths } = {}; // group -> [ops]

  for (const file of files) {
    try {
      const { importMap, routes, baseGroup } = extractRoutesFromFile(file);
      const groupBase = baseGroup || "/";
      for (const r of routes) {
        let fullPath = r.path;
        if (groupBase && groupBase !== "/") {
          // Ensure proper path joining without double slashes
          fullPath = `/${groupBase.replace(/^\/+/, "")}/${r.path.replace(/^\/+/, "")}`.replace(
            /\/+/g,
            "/"
          );
        }
        // Convert express path param :id to openapi style {id}
        const openapiPath = fullPath.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
        const pathParamsFromPath: string[] = [];
        const paramMatches = [...fullPath.matchAll(/:([A-Za-z0-9_]+)/g)];
        if (paramMatches.length) {
          for (const m of paramMatches) pathParamsFromPath.push(m[1]!);
        }

        // Default operation stub
        const op: OpenAPIOperation = {
          summary: r.tags.join(", "),
          tags: [groupBase && groupBase !== "/" ? groupBase.replace(/^\/+/, "") : "default"],
          parameters: [],
          responses: {
            "200": {
              description: "Successful response",
              content: {
                "application/json": {
                  schema: { type: "object" },
                },
              },
            },
          },
        };

        // if path has :params, add path params (we will fill types potentially from validator)
        for (const pName of pathParamsFromPath) {
          op.parameters.push({
            name: pName,
            in: "path",
            required: true,
            schema: { type: "string" },
          });
        }

        // If validateInfo exists, resolve validator module and build request schemas
        if (r.validateInfo && r.validateInfo.validatorVar) {
          const varName = r.validateInfo.validatorVar;
          const memberName = r.validateInfo.validatorMember;
          const importSource = importMap[varName];
          if (importSource) {
            const resolved = resolveImportToFile(importSource, file);
            if (resolved) {
              let mod;
              try {
                mod = safeRequire(resolved);
              } catch (err: any) {
                console.warn(
                  `Warning: cannot require validator module ${resolved}: ${err.message}`
                );
                mod = null;
              }
              if (mod) {
                let joiDescribe: JoiDescribe | null = null;
                if (memberName) {
                  joiDescribe = joiSchemaDescribeFromModule(mod, memberName);
                } else {
                  // If validatorVar exported a single schema or default
                  // try to find the main export
                  if (mod && typeof mod === "object" && Object.keys(mod).length === 1) {
                    const onlyKey = Object.keys(mod)[0];
                    joiDescribe = joiSchemaDescribeFromModule(mod, onlyKey!);
                  } else if (mod && typeof mod.describe === "function") {
                    try {
                      joiDescribe = mod.describe();
                    } catch {
                      joiDescribe = null;
                    }
                  }
                }

                if (joiDescribe) {
                  // According to your validator examples, there is a root object with keys: body, query, params
                  const keys = joiDescribe.keys || {};
                  // body
                  if (r.validateInfo.options && r.validateInfo.options.body && keys.body) {
                    const bodyDescribe = keys.body;
                    const rb = buildRequestBodyFromJoi(bodyDescribe);
                    if (rb) op.requestBody = rb;
                  }
                  // query
                  if (r.validateInfo.options && r.validateInfo.options.query && keys.query) {
                    const queryParams = buildParametersFromJoi(keys.query, "query");
                    op.parameters = op.parameters.concat(queryParams);
                  }
                  // params
                  if (r.validateInfo.options && r.validateInfo.options.params && keys.params) {
                    const pathParams = buildParametersFromJoi(keys.params, "path");
                    // merge/overwrite existing path params from URL by name and type
                    for (const pp of pathParams) {
                      const existingIndex = op.parameters.findIndex(
                        (p) => p.name === pp.name && p.in === "path"
                      );
                      if (existingIndex >= 0) op.parameters[existingIndex] = pp;
                      else op.parameters.push(pp);
                    }
                  } else {
                    // if no explicit params option but path had :id, attempt to add from keys.params if any exist
                    if (pathParamsFromPath.length && keys.params) {
                      const pathParams = buildParametersFromJoi(keys.params, "path");
                      for (const pp of pathParams) {
                        const existingIndex = op.parameters.findIndex(
                          (p) => p.name === pp.name && p.in === "path"
                        );
                        if (existingIndex >= 0) op.parameters[existingIndex] = pp;
                        else op.parameters.push(pp);
                      }
                    }
                  }
                }
              }
            } else {
              console.warn(`Could not resolve import ${importSource} from ${file}`);
            }
          } else {
            console.warn(`Validator variable ${varName} not found in imports of ${file}`);
          }
        } else {
          // If no validate middleware but there are query/path params in path - keep path params
          // nothing to add
        }

        // If route has file upload, add request body for multipart/form-data
        if (r.fileUploadInfo) {
          const properties: { [key: string]: any } = {};
          if (r.fileUploadInfo.type === "single" && r.fileUploadInfo.fieldName) {
            properties[r.fileUploadInfo.fieldName] = {
              type: "string",
              format: "binary",
            };
          } else if (r.fileUploadInfo.type === "fields" && r.fileUploadInfo.fields) {
            for (const field of r.fileUploadInfo.fields) {
              properties[field.name] = {
                type: "string",
                format: "binary",
              };
            }
          }

          op.requestBody = {
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  properties,
                },
              },
            },
          };
        }

        // If route used validateAccess, add security requirement (bearerAuth)
        if (r.hasValidateAccess) {
          op.security = [{ bearerAuth: [] }];
        }

        // HTTP method
        const method = r.method || "get";

        // Add to group
        const groupKey = groupBase || "/";
        if (!operationsByGroup[groupKey]) operationsByGroup[groupKey] = {};
        if (!operationsByGroup[groupKey][openapiPath])
          operationsByGroup[groupKey][openapiPath] = {};
        operationsByGroup[groupKey][openapiPath][method] = op;
      }
    } catch (err: any) {
      console.warn(`Failed to process ${file}: ${err.message}`);
    }
  }

  // Assemble full OpenAPI document
  const openapi: OpenAPIDocument = {
    openapi: "3.0.3",
    info: {
      title: "Auto-generated API",
      description: "Generated from Express route files and Joi validators",
      version: "1.0.0",
    },
    servers: [{ url: SERVER_URL }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
      schemas: {},
    },
    paths: {},
  };

  // Flatten operationsByGroup into paths (groupBase + routePath are already combined)
  for (const [, pathsObj] of Object.entries(operationsByGroup)) {
    for (const [pth, methods] of Object.entries(pathsObj)) {
      // ensure path is absolute
      const outPath = pth.startsWith("/") ? pth : `/${pth}`;
      if (!openapi.paths[outPath]) openapi.paths[outPath] = {};
      for (const [method, op] of Object.entries(methods)) {
        openapi.paths[outPath][method] = op;
      }
    }
  }

  // Write YAML
  const yamlStr = yaml.dump(openapi, { noRefs: true, lineWidth: 120 });
  fs.writeFileSync(OUT_FILE, yamlStr, "utf8");
  console.log(`Wrote OpenAPI YAML to ${OUT_FILE}`);
}

// Run main
main();
