import mongoose from "mongoose";
import { newMongoDBConnection } from "../config/db";
import * as roleRepository from "../repository/v1/role";
import logger from "../config/logger";

const COMMON_ROLES = [
  // Engineering / Tech
  { name: "frontend developer", description: "Builds user-facing web interfaces" },
  { name: "backend developer", description: "Builds server-side application logic and APIs" },
  { name: "full stack developer", description: "Works across frontend and backend systems" },
  { name: "mobile developer", description: "Builds mobile applications" },
  { name: "devops engineer", description: "Manages infrastructure, CI/CD, and deployments" },
  { name: "qa engineer", description: "Tests software for quality and reliability" },
  { name: "data engineer", description: "Builds and maintains data pipelines and infrastructure" },
  { name: "data scientist", description: "Builds models and derives insights from data" },
  { name: "security engineer", description: "Protects systems and data from security threats" },
  // Design & Product
  { name: "product designer", description: "Designs product experiences and interfaces" },
  { name: "ui/ux designer", description: "Designs user interfaces and experiences" },
  { name: "graphic designer", description: "Creates visual content for digital and print media" },
  { name: "product manager", description: "Defines product strategy and roadmap" },
  { name: "project manager", description: "Plans and coordinates project delivery" },
  { name: "business analyst", description: "Analyzes business processes and requirements" },
  // Marketing
  { name: "marketing manager", description: "Plans and oversees marketing campaigns and strategy" },
  {
    name: "digital marketing specialist",
    description: "Runs online marketing campaigns across channels",
  },
  {
    name: "content marketing specialist",
    description: "Creates content to attract and engage audiences",
  },
  { name: "social media manager", description: "Manages brand presence on social media platforms" },
  { name: "seo specialist", description: "Optimizes content and sites for search visibility" },
  // Sales & Business Development
  { name: "sales representative", description: "Sells products or services to customers" },
  { name: "account executive", description: "Manages client accounts and drives revenue growth" },
  {
    name: "business development manager",
    description: "Identifies and develops new business opportunities",
  },
  {
    name: "customer success manager",
    description: "Ensures customers achieve value from a product",
  },
  // Operations, Finance & People
  { name: "operations manager", description: "Oversees day-to-day business operations" },
  { name: "hr manager", description: "Manages recruitment, people operations, and HR policy" },
  {
    name: "talent acquisition specialist",
    description: "Sources and recruits candidates for open roles",
  },
  { name: "finance analyst", description: "Analyzes financial data to support business decisions" },
  { name: "accountant", description: "Manages financial records, reporting, and compliance" },
  // Support
  {
    name: "customer support specialist",
    description: "Assists customers with product issues and questions",
  },
];

const seedRoles = async () => {
  await newMongoDBConnection();
  for (const role of COMMON_ROLES) {
    const existing = await roleRepository.findRoleByMatch({ name: role.name });
    if (!existing) {
      await roleRepository.createRole(role);
      logger.log(`Seeded role: ${role.name}`);
    }
  }
  await mongoose.connection.close();
};

seedRoles().catch((err) => {
  logger.logErrorMessage(`Role seeding failed: ${err.message}`);
  process.exit(1);
});
