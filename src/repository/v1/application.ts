import Application from "../../models/v1/application";
import { Page, Paging } from "../../typings/customs";
import {
  ApplicationStatus,
  IApplication,
  ScreeningStage,
  TApplicationStatus,
  TApplicationType,
  TScreeningStage,
} from "../../typings/application";
import { FilterQuery, PipelineStage, Types, UpdateQuery } from "mongoose";
import * as func from "../../helpers/func";
import { IProfile, IUser } from "../../typings/user";

export const createApplication = (application: Partial<IApplication>) => {
  return new Application(application);
};

export const bulkWrite = async (
  // bulkOps: AnyBulkWriteOperation<IApplication>[]
  bulkOps: any
) => {
  return await Application.bulkWrite(bulkOps);
};

export const findApplicationById = async (id: Types.ObjectId | string) => {
  return await Application.findById(id)
    .populate({
      path: "role job",
      select: "-__v -createdAt -updatedAt ",
      strictPopulate: false,
    })
    .populate({
      path: "talent",
      populate: "profile",
    });
};

export const createOrUpdateApplication = async (
  job: string | Types.ObjectId,
  talent: string | Types.ObjectId,
  update: Partial<IApplication> | UpdateQuery<IApplication>
) => {
  return await Application.findOneAndUpdate(
    { job, talent },
    { ...update },
    {
      upsert: true,
      new: true,
      includeResultMetadata: true,
      runValidators: true,
    }
  );
};

export const findAllApplications = async (paging: Paging = {}) => {
  return await Application.find()
    .sort({ updatedAt: func.sortDirection(paging.sort!) || Page.Sort })
    .skip(Number(paging.offset) || Page.Offset)
    .limit(Number(paging.limit) || Page.Limit)
    .populate({
      path: "role",
      select: "-__v -createdAt -updatedAt ",
      strictPopulate: false,
    });
};

export const findApplicationByMatch = async (
  data: FilterQuery<IApplication>
) => {
  return await Application.findOne(data);
};

export const findApplicationsByMatch = async (
  data: FilterQuery<IApplication>,
  paging: Paging = {}
) => {
  return await Application.find(data)
    .populate({
      path: "job",
      select: "role postedBy description",
      populate: [
        {
          path: "role",
          select: "name description",
        },
        {
          path: "postedBy",
          select: "firstName lastName email",
        },
      ],
    })
    .select("-personalizedQuestions")
    .sort({ updatedAt: -1 })
    .skip(Number(paging.offset) || Page.Offset)
    .limit(Number(paging.limit) || Page.Limit);
};

//   export const applicationsByMatch = async (
//     data: FilterQuery<IApplication>,
//     paging: Paging = {}
//   ) => {
//     return await Application.find(data)
//     .populate({
//       path: "job",
//       select: "role postedBy description",
//       populate: [
//         {
//           path: "role",
//           select: "name description",
//         },
//       ],
//     })
//     .select("-personalizedQuestions")
//     .sort(paging.sortMethod)
//     .skip(Number(paging.offset) || Page.Offset)
//     .limit(Number(paging.limit) || Page.Limit);
// };

export const leanApplicationsByMatch = async (
  data: FilterQuery<IApplication>,
  paging: Paging = {}
) => {
  return await Application.find(data)
    .populate({
      path: "talent",
      select: "firstName lastName",
    })
    .populate({
      path: "job",
      select: "role",
      populate: [
        {
          path: "role",
          select: "name",
        },
      ],
    })
    .select("-personalizedQuestions")
    .sort({ updatedAt: -1 })
    .skip(Number(paging.offset) || Page.Offset)
    .limit(Number(paging.limit) || Page.Limit);
};

export const findApplicationByMatchAndUpdate = async (
  filter: FilterQuery<IApplication>,
  data: Partial<IApplication>
) => {
  return await Application.findOneAndUpdate(filter, data, {
    new: true,
  });
};

export const countApplications = async (filter: FilterQuery<IApplication>) => {
  return await Application.countDocuments(filter);
};

export const applicationAggregate = async (
  data: PipelineStage[],
  paging: Paging = {}
) => {
  return await Application.aggregate(data);
};

// Update current stage of application
export const updateCurrentStage = (
  stage: TScreeningStage,
  stages: Map<TScreeningStage, TScreeningStage>
): { currentStage: TScreeningStage; applicationStatus: TApplicationStatus } => {
  const currentStage = stages.get(stage);

  if (!currentStage) {
    throw new Error("Next stage not found");
  }
  // if (currentStage == ScreeningStage.Completed) {
  //   return { currentStage, applicationStatus: ApplicationStatus.Shortlisted };
  // }
  return { currentStage, applicationStatus: ApplicationStatus.Pending };
};

export const calculateAverageScore = (
  application: IApplication,
  prescreeningScore: number
) => {
  const scores = [
    application.cvSimilarityScore,
    application.personalizedScore,
    prescreeningScore,
  ].filter((score) => score !== null && score !== undefined) as number[];

  if (scores.length === 0) return 0;

  if (scores.length > 0) {
    const totalScore = scores.reduce((acc, score) => acc + score, 0);
    return Number((totalScore / scores.length).toFixed(2));
  }
};

export const rankApplications = async (
  talent: IUser,
  application: IApplication
) => {
  application.averageScore = calculateAverageScore(
    application,
    (talent.profile as IProfile).prescreeningScore
  );

  // Find the new rank based on the average score
  const newRank = await Application.countDocuments({
    averageScore: { $gt: application.averageScore },
    job: application.job,
  });

  // New rank is newRank + 1 (since rank starts at 1)
  const newRankPosition = newRank + 1;

  // Adjust the ranks of other candidates
  if (application.rank) {
    // Talent was ranked before, adjust ranks of other candidates accordingly
    if (application.rank < newRankPosition) {
      // Talent moved down, increment ranks of candidates between old and new rank
      await Application.updateMany(
        { rank: { $gt: application.rank, $lte: newRankPosition } },
        { $inc: { rank: -1 } } // Decrease rank by 1 for those moved up
      );
    } else {
      // Talent moved up, decrement ranks of candidates between new and old rank
      await Application.updateMany(
        { rank: { $gte: newRankPosition, $lt: application.rank } },
        { $inc: { rank: 1 } } // Increase rank by 1 for those moved down
      );
    }
  } else {
    // Talent was not ranked before, so we need to shift all candidates below the new rank
    await Application.updateMany(
      { rank: { $gte: newRankPosition } },
      { $inc: { rank: 1 } } // Shift ranks down by 1 for those below the new rank
    );
  }

  application.rank = newRankPosition;
  await application.save();
  return application;
};

// Update current stage of application
export const processNextStage = async (
  talent: IUser,
  application: IApplication,
  stage: TScreeningStage
) => {
  const currentStage = application.stages.get(stage);

  if (!currentStage) {
    throw new Error("Next stage not found");
  }
  application.currentStage = currentStage;
  if (currentStage == ScreeningStage.Completed) {
    application = await rankApplications(talent, application);
    application.status = ApplicationStatus.Shortlisted;

    return application;
  }
  application.status = ApplicationStatus.Pending;

  return application;
};
