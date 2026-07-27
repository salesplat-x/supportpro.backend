import "reflect-metadata";
import "dotenv/config";
import { Not, IsNull } from "typeorm";
import { AppDataSource } from "../database/dataSource.js";
import { Application } from "../entities/Application.js";
import logger from "../utils/logger.js";

// One-off fix-up for data written before the rankApplication() counting bug
// was fixed (rank could exceed the number of applicants who'd actually
// finished, e.g. "rank 3 of 2"). The relative order applications were ranked
// in was always correct — only the numeric values were inflated — so this
// just renumbers each job's already-ranked applications 1..N in their
// existing order.
async function run(): Promise<void> {
  await AppDataSource.initialize();
  const applicationRepo = AppDataSource.getRepository(Application);

  const jobIds: { jobId: string }[] = await applicationRepo
    .createQueryBuilder("application")
    .select("DISTINCT application.job_id", "jobId")
    .where("application.rank IS NOT NULL")
    .getRawMany();

  let fixedJobs = 0;
  let fixedApplications = 0;

  for (const { jobId } of jobIds) {
    const applications = await applicationRepo.find({
      where: { jobId, rank: Not(IsNull()) },
      order: { rank: "ASC" },
    });

    let changed = false;
    for (let i = 0; i < applications.length; i++) {
      const correctRank = i + 1;
      if (applications[i]!.rank !== correctRank) {
        applications[i]!.rank = correctRank;
        changed = true;
      }
    }

    if (changed) {
      await applicationRepo.save(applications);
      fixedJobs += 1;
      fixedApplications += applications.length;
    }
  }

  logger.info(
    `Rank recompute: renumbered applications for ${fixedJobs} job(s), ${fixedApplications} application(s) touched`
  );
  await AppDataSource.destroy();
}

run().catch((err: Error) => {
  logger.error(`Rank recompute failed: ${err.message}`);
  process.exit(1);
});
