import "reflect-metadata";
import "dotenv/config";
import { AppDataSource } from "../database/dataSource.js";
import { User } from "../entities/User.js";
import { UserRole } from "../types/enums.js";
import { generateHashedPassword } from "../utils/crypto.js";
import logger from "../utils/logger.js";

async function run(): Promise<void> {
  await AppDataSource.initialize();
  const userRepo = AppDataSource.getRepository(User);

  const existingAdmin = await userRepo.findOne({ where: { userRole: UserRole.Admin } });
  if (existingAdmin) {
    logger.info(`Admin already exists: id=${existingAdmin.id} email=${existingAdmin.email}`);
    await AppDataSource.destroy();
    return;
  }

  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error("Missing required environment variables: ADMIN_EMAIL, ADMIN_PASSWORD");
  }

  const hashedPassword = await generateHashedPassword(password);
  const admin = userRepo.create({
    email: email.toLowerCase(),
    password: hashedPassword,
    firstName: "Admin",
    lastName: "Admin",
    userRole: UserRole.Admin,
    emailVerified: true,
    active: true,
    roleChangeCount: 0,
  });
  const saved = await userRepo.save(admin);
  logger.info(`Admin created: id=${saved.id} email=${saved.email}`);

  await AppDataSource.destroy();
}

run().catch((err: Error) => {
  logger.error(`Admin seed failed: ${err.message}`);
  process.exit(1);
});
