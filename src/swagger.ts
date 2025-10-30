import {Application, Express, Request, Response} from 'express'
import swaggerJsdoc from 'swagger-jsdoc'
import swaggerUi from 'swagger-ui-express'
import {version} from '../package.json'
import logger from './config/logger'
import fs from 'fs';
import yaml from 'js-yaml';
import path from 'path';

function loadSwaggerSpec():swaggerUi.JsonObject | null {
  try {
    const filePath = path.join(__dirname, '../swagger.yaml');
    if (!fs.existsSync(filePath)) {
      throw new Error('Swagger file not found');
    }
    
    const fileContents = fs.readFileSync(filePath, 'utf8');
    return yaml.load(fileContents) as swaggerUi.JsonObject;
  } catch (error) {
    console.error('Error loading Swagger spec:', error);
    return null;
  }
}

// Serve Swagger UI
const swaggerSpec = loadSwaggerSpec();

function swaggerDocs(app: Application, port: number){
    app.use('/v1/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec))

    app.get('/v1/docs.json', (req: Request, res: Response) =>{
        res.setHeader('Content-Type', 'application/json')
        res.send(swaggerSpec)
    });
    logger.log(`Docs available at http://localhost:${port}/v1/docs`)
}

export default swaggerDocs