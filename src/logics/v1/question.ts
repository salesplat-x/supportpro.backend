import * as questionRepository from "../../repository/v1/question";
import * as roleRepository from "../../repository/v1/role";
import * as userRepository from "../../repository/v1/user";
import * as answerRepository from "../../repository/v1/answer";
import { makeResponse } from "../../helpers/response";
import {
  AnswerQuestionPayload,
  IGenerateQuestions,
  IQuestion,
  IQuestionConstruct,
} from "../../typings/question";
import mongoose from "mongoose";
import { IProfile, IUser } from "../../typings/user";
import { Paging } from "../../typings/customs";
import {
  generatePersonalizedQuestions,
  gradeAnswers,
} from "../../servces/v1/openai";
import { IRole } from "../../typings/role";
import { IResponse } from "../../typings/answer";
import { getJob, getTalents } from "../../repository/v1/pg";

// Function to create/add question for role
export const createQuestion = async (payload: IQuestion) => {
  if (!mongoose.Types.ObjectId.isValid(payload.role as string)) {
    return makeResponse(false, "Invalid role id", {}, 400);
  }
  const existingRole = await roleRepository.findRoleById(payload.role as string);
  if (!existingRole) {
    return makeResponse(false, "Role does not exist", {}, 404);
  }
  let question = await questionRepository.createQuestion(payload);
  return makeResponse(true, "Question posted successfully", question, 200);
};

// Function to fetch all questions
export const fetchAllQuestions = async (payload: Paging) => {
  let questions = await questionRepository.findAllQuestions(payload);
  return makeResponse(true, "Questions fetched successfully", questions, 200);
};

// Function to fetch a question
export const fetchQuestion = async (payload: Pick<IQuestion, "_id">) => {
  if (!mongoose.Types.ObjectId.isValid(payload._id!)) {
    return makeResponse(false, "Invalid question id", {}, 400);
  }
  let question = await questionRepository.findQuestionById(payload._id!);
  if (!question) {
    return makeResponse(false, "Question not found", {}, 404);
  }
  return makeResponse(true, "Question fetched successfully", question, 200);
};

// Function to answer questions
export const answerQuestions = async (
  user: IUser,
  payload: AnswerQuestionPayload
) => {
  if ((user.profile as IProfile).score) {
    return makeResponse(false, "User has already taken assessment");
  }

  if (payload.answers.length > 15) {
    return makeResponse(false, "Maximum length of answers 15 has been exceeded");
  }

  // Get all question by Id
  const questionIds = payload.answers.map((answer) => answer.questionId);
  const questions = await questionRepository.findQuestionByMatch({
    role: payload.roleId,
    _id: { $in: questionIds },
  });

  if (
    payload.roleId !=
    ((user.profile as IProfile).role[0]! as IRole)._id.toString()
  ) {
    return makeResponse(
      false,
      "User is not permitted to take assessment for this role"
    );
  }

  if (questions.length !== payload.answers.length) {
    return makeResponse(false, "One of more questions do not belong to role");
  }

  // Map questions by ID for efficient lookup
  const questionMap = new Map(
    questions.map((q) => [
      q._id.toString(),
      {
        question: q.question,
        criteria: q.criteria,
      },
    ])
  );

  // Validate answers and prepare valid answers for grading
  const questionsConstruct = payload.answers.reduce(
    (questionConstruct: IQuestionConstruct[], ans) => {
      const question = questionMap.get(ans.questionId as string);
      if (question) {
        questionConstruct.push({
          questionId: ans.questionId,
          question: question.question,
          answer: ans.answer,
          criteria: question.criteria,
        });
      }
      return questionConstruct;
    },
    []
  );

  const questionsJSON = JSON.stringify(questionsConstruct);

  // Use LLM to grade scores
  const response = await gradeAnswers(questionsJSON);
  if (!response || !response.message.content) {
    return makeResponse(false, "Error with LLM", {}, 400);
  }

  const responseArray: IResponse[] = JSON.parse(
    response.message.content
  ).responses;

  if (responseArray.length != questionsConstruct.length) {
    return makeResponse(
      false,
      "Length of response array doesn't match length of input array"
    );
  }

  let totalScore = 0;
  for (const response of responseArray) {
    if (response.score > 5) {
      return makeResponse(false, "Score exceeds the maximum assignable score");
    }
    totalScore += response.score;
  }
  const maxScore = 5 * 15;
  const scorePercent = Number(((totalScore / maxScore) * 100).toFixed(2));

  await answerRepository.saveOrUpdateAnswer(
    user._id,
    payload.roleId,
    responseArray
  );

  await userRepository.updateUserScore(
    (user.profile as IProfile)._id,
    scorePercent
  );
  return makeResponse(true, "Answers submitted successfully", { scorePercent });
};

const job = {
  job_description:
    "Job Title: Business Analyst Location: Akure, Ondo State Company: Kuji Labs Type: Full-Time Department: Business Analysis Reports To: Project Manager/Director of Business Analysis Job Overview: We are seeking a highly motivated and detail-oriented Business Analyst to join our dynamic team. The Business Analyst will play a critical role in analyzing business processes, identifying opportunities for improvement, and collaborating with various departments to implement solutions that drive efficiency and growth. The ideal candidate has a strong analytical mindset, excellent communication skills, and the ability to work effectively in a fast-paced environment. Key Responsibilities: 1. Requirements Gathering and Analysis: - Conduct detailed interviews with stakeholders to understand business needs and objectives. - Document and analyze business requirements, processes, and workflows. - Translate business requirements into functional specifications for technical teams. 2. Data Analysis and Reporting: - Collect, analyze, and interpret data to identify trends and patterns. - Develop and maintain reports and dashboards to monitor business performance. - Provide insights and recommendations based on data analysis to support decision-making. 3. Process Improvement: - Evaluate existing business processes and identify areas for improvement. - Propose and implement process enhancements to optimize efficiency and effectiveness. - Work closely with cross-functional teams to ensure seamless implementation of new processes. 4. Project Management Support: - Assist in project planning, execution, and monitoring. - Coordinate with project teams to ensure timely delivery of project milestones. - Track project progress and report on status to stakeholders. 5. Stakeholder Communication: - Serve as a liaison between business units, technology teams, and support teams. - Facilitate meetings and workshops to gather and communicate business requirements. - Ensure all stakeholders are informed of project developments and changes. Qualifications: - Bachelors degree in Business Administration, Information Technology, or a related field. - Minimum of 3 years of experience in business analysis or a similar role. - Strong analytical and problem-solving skills. - Proficiency in data analysis tools and software (e.g., Excel, SQL, Tableau). - Excellent written and verbal communication skills. - Ability to work independently and as part of a team. - Strong organizational skills and attention to detail. - Experience with project management methodologies (e.g., Agile, Scrum) is a plus. - Certification in Business Analysis (e.g., CBAP, CCBA) is desirable. What We Offer: - Competitive salary and benefits package. - Opportunities for professional development and career growth. - Collaborative and inclusive work environment. - Flexible work hours and potential for remote work.",
};
const talent = [
  {
    cv_text:
      "Jane Smith Agency Sales Lead Phone: +1 555-987-6543 Email: janesmith@gmail.com Summary Results-driven Agency Sales Lead with over 10 years of experience in leading sales teams, developing strategic sales plans, and driving revenue growth in competitive markets. Expert in client relationship management, market analysis, and team leadership. Demonstrated ability to exceed sales targets and foster long-term business partnerships. Professional Experience Agency Sales Lead Top Marketing Solutions Los Angeles, CA March 2018 - Present Lead a team of 15 sales representatives, providing mentorship and training to enhance performance. Develop and implement strategic sales plans to achieve company objectives and revenue targets. Build and maintain strong relationships with key clients, ensuring high levels of customer satisfaction and retention. Analyze market trends and competitor activities to identify new business opportunities. Achieved a 25% increase in annual sales revenue through effective sales strategies and team collaboration. Sales Manager Creative Advertising Agency Chicago, IL September 2013 - February 2018 Managed a team of 10 sales professionals, driving sales growth through targeted marketing campaigns and personalized client interactions. Conducted regular performance reviews and provided ongoing training to improve team effectiveness. Collaborated with the marketing team to develop promotional materials and sales presentations. Successfully negotiated and closed high-value contracts with major corporate clients. Increased regional sales by 30% within two years by implementing innovative sales techniques. Senior Sales Executive Dynamic Media Group Austin, TX June 2009 - August 2013 Identified and pursued new business opportunities through networking and market research. Maintained a robust sales pipeline and consistently met or exceeded sales quotas. Developed customized sales proposals and presentations tailored to client needs. Fostered strong relationships with clients, resulting in repeat business and referrals. Recognized as the top sales performer for three consecutive years. Education Bachelor of Business Administration (BBA) in Marketing University of Texas at Austin Austin, TX Graduated: May 2009 Skills Sales Strategy Development Team Leadership and Mentorship Client Relationship Management Market Analysis and Research Negotiation and Closing Performance Management CRM Software (Salesforce, HubSpot) Excellent Communication and Presentation Skills Certifications Certified Sales Leadership Professional (CSLP) Strategic Sales Management Certification",
  },
];
// Function to generate personalized questions
export const personalizedQuestions = async (payload: IGenerateQuestions) => {
  // const job = await getJob(payload.jobId);
  if (!job) {
    return makeResponse(false, "Job not found", {}, 404);
  }

  // const talent = await getTalents(payload.talentId);

  if (talent.length == 0) {
    return makeResponse(false, "Talent not found", {}, 404);
  }
  const cv = talent.map((t) => t.cv_text);
  const recruiterGuide = payload.recruiterGuide?.length
    ? payload.recruiterGuide
    : [
        "Make sure to check the talent's CV and ask questions to test the validity of the claims",
      ];

  const response = await generatePersonalizedQuestions(
    job.job_description,
    cv,
    recruiterGuide
  );
  if (!response || !response.message.content) {
    return makeResponse(false, "Error with LLM", {}, 400);
  }
  const questions = JSON.parse(response.message.content).questions;
  return makeResponse(true, "Question fetched successfully", { questions }, 200);
};
