import { IUser } from "../../typings/user";
import { ApplicationType, IApplication, IApplicationCompilation } from "../../typings/application";
import * as applicationRepository from "../../repository/v1/application";
import { makeResponse } from "../../helpers/response";
import mongoose, { FilterQuery, PipelineStage, Types } from "mongoose";
import { Request } from "express";
import { findJobById } from "../../repository/v1/job";

export const recruiterDashboard = async (req: Request) => {
  const { jobId } = req.query; // Pagination params

  const recruiter = req.user._id; // Assuming req.user.id contains the recruiter ID
  const recentCompilationsMatch: FilterQuery<IApplication> = { recruiter };
  const applicationMatch: FilterQuery<IApplication> = {
    recruiter,
    applicationType: ApplicationType.Application,
  };

  if (jobId) {
    recentCompilationsMatch.job = new mongoose.Types.ObjectId(jobId as string);
  }

  const results = await applicationRepository.applicationAggregate([
    {
      $facet: {
        campaignCount: [
          { $match: { recruiter } },
          {
            $group: {
              _id: null,
              totalCampaigns: { $sum: 1 }, // Count all campaigns
              completedCampaigns: {
                $sum: {
                  $cond: [{ $eq: ["$currentStage", "completed"] }, 1, 0],
                },
              }, // Count campaigns with completed stage
            },
          },
          {
            $project: {
              totalCampaigns: 1,
              completedCampaigns: 1,
              completionRatio: {
                $cond: [
                  { $eq: ["$totalCampaigns", 0] },
                  0,
                  {
                    $round: [
                      {
                        $multiply: [
                          {
                            $divide: ["$completedCampaigns", "$totalCampaigns"],
                          },
                          100,
                        ],
                      },
                      0, // Rounding to 0 decimal places
                    ],
                  },
                ],
              },
            },
          },
        ],

        applicationsCount: [{ $match: applicationMatch }, { $count: "count" }],

        shortlistCount: [{ $match: { recruiter, status: "shortlisted" } }, { $count: "count" }],

        recentApplications: [
          { $match: applicationMatch },
          { $sort: { createdAt: -1 } },
          { $limit: 3 },
          {
            $lookup: {
              from: "users",
              localField: "talent",
              foreignField: "_id",
              as: "talentDetails",
            },
          },
          {
            $lookup: {
              from: "profiles",
              localField: "talentDetails.profile",
              foreignField: "_id",
              as: "profileDetails",
            },
          },
          {
            $unwind: "$talentDetails",
          },
          {
            $unwind: "$profileDetails",
          },
          {
            $project: {
              applicantName: {
                $concat: ["$talentDetails.firstName", " ", "$talentDetails.lastName"],
              },
              prescreeningScore: "$profileDetails.prescreeningScore",
              cvSimilarityScore: "$cvSimilarityScore",
              dateApplied: "$createdAt",
            },
          },
        ],
        recentCompilations: [
          { $match: recentCompilationsMatch },
          { $sort: { updatedAt: -1 } },
          { $limit: 4 },
          {
            $lookup: {
              from: "users",
              localField: "talent",
              foreignField: "_id",
              as: "talentDetails",
            },
          },
          {
            $lookup: {
              from: "profiles",
              localField: "talentDetails.profile",
              foreignField: "_id",
              as: "profileDetails",
            },
          },
          {
            $lookup: {
              from: "roles",
              localField: "profileDetails.role",
              foreignField: "_id",
              as: "role",
            },
          },
          {
            $unwind: "$talentDetails",
          },
          {
            $unwind: "$profileDetails",
          },
          {
            $unwind: "$role",
          },
          {
            $project: {
              applicantName: {
                $concat: ["$talentDetails.firstName", " ", "$talentDetails.lastName"],
              },
              mbtiType: "$mbtiType",
              prescreeningScore: "$profileDetails.prescreeningScore",
              cvSimilarityScore: "$cvSimilarityScore",
              status: "$status",
              currentStage: "$currentStage",
              job: "$job",
              role: "$role.name",
              dateApplied: "$createdAt",
            },
          },
        ],
      },
    },
    {
      $project: {
        campaignCount: {
          $ifNull: [{ $arrayElemAt: ["$campaignCount.totalCampaigns", 0] }, 0],
        },
        completedCampaigns: {
          $ifNull: [{ $arrayElemAt: ["$campaignCount.completedCampaigns", 0] }, 0],
        },
        completionRatio: {
          $ifNull: [{ $arrayElemAt: ["$campaignCount.completionRatio", 0] }, 0],
        },
        applicationsCount: {
          $ifNull: [{ $arrayElemAt: ["$applicationsCount.count", 0] }, 0],
        },
        shortlistCount: {
          $ifNull: [{ $arrayElemAt: ["$shortlistCount.count", 0] }, 0],
        },
        recentApplications: 1,
        recentCompilations: 1,
      },
    },
  ]);

  return makeResponse(true, "User's job applications fetched", {
    data: results[0],
  });
};

// export const applications = async (
//   user: IUser,
//   payload: IApplicationCompilation
// ) => {
//   const { job, applicationType } = payload;
//   payload.sortMethod = { updatedAt: -1 };

//   const query: FilterQuery<IApplication> = { recruiter: user.id };

//   if (job) {
//     query.job = job;
//   }

//   if (applicationType) {
//     query.applicationType = applicationType;
//     if (applicationType === ApplicationType.Application) {
//       payload.sortMethod = { createdAt: -1 };
//     }
//   }

//   const applications = await applicationRepository.applicationsByMatch(
//     query,
//     payload
//   );

//   return makeResponse(true, "User's job applications fetched", {
//     applications,
//   });
// };

export const applications = async (user: IUser, payload: IApplicationCompilation) => {
  const { job, applicationType, offset, limit } = payload;

  const applicationMatch: any = { recruiter: user._id };
  if (job) {
    const _job = await findJobById(job);
    if (!_job) {
      return makeResponse(false, "Job not found", {}, 404);
    }
    if ((_job.postedBy as IUser)._id.toString() !== user._id.toString()) {
      return makeResponse(false, "You are not authorized to perform this action", {}, 403);
    }
    applicationMatch.job = new Types.ObjectId(job);
  }

  if (applicationType) {
    applicationMatch.applicationType = applicationType;
    if (applicationType === ApplicationType.Application) {
      payload.sortMethod = { createdAt: -1 };
    }
  }

  // Aggregation pipeline
  const pipeline: PipelineStage[] = [
    {
      $match: applicationMatch,
    },
    {
      $lookup: {
        from: "users",
        localField: "talent",
        foreignField: "_id",
        as: "talent",
      },
    },
    {
      $unwind: "$talent",
    },
    {
      $lookup: {
        from: "profiles",
        localField: "talent.profile",
        foreignField: "_id",
        as: "profile",
      },
    },
    {
      $unwind: "$profile",
    },
    // {
    //   $sort: payload.sortMethod!,
    // },
  ];

  // Add optional pagination stages if limit and skip are provided
  if (offset) {
    pipeline.push({ $skip: Number(offset) });
  }
  if (limit) {
    pipeline.push({ $limit: Number(limit) });
  }

  pipeline.push({
    $project: {
      _id: 1,
      job: 1,
      talent: {
        _id: "$talent._id",
        email: "$talent.email",
        firstName: "$talent.firstName",
        lastName: "$talent.lastName",
        profile: {
          _id: "$profile._id",
          bio: "$profile.bio",
          experience: "$profile.experience",
          maxSalary: "$profile.maxSalary",
          minSalary: "$profile.minSalary",
          prescreeningScore: "$profile.prescreeningScore",
        },
      },
      recruiter: 1,
      applicationType: 1,
      status: 1,
      personalizedScore: 1,
      cvSimilarityScore: 1,
      mbtiType: 1,
      createdAt: 1,
      updatedAt: 1,
    },
  });

  const applications = await applicationRepository.applicationAggregate(pipeline);

  return makeResponse(true, "User's job applications fetched", {
    applications,
  });
};
