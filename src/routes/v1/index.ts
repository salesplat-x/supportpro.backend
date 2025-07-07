import { Router } from "express";

import main from "./main";
import auth from "./auth";
import job from "./job";
import role from "./role";
import user from "./user";
import upload from "./upload";
import question from "./question";
import scout from "./scout";
import recruiter from "./recruiter";
import application from "./application";
import message from "./message";
import conversation from "./conversation";
import notification from "./notification";
import organization from "./organization";
import aiconfig from "./aiconfig";
import payment from "./payment";
import plan from "./plan";
import subscription from "./subscription";

export default (router: Router) => {
  main(router);
  auth(router);
  user(router);
  job(router);
  role(router);
  upload(router);
  aiconfig(router);
  recruiter(router);
  scout(router);
  question(router);
  application(router);
  conversation(router);
  message(router);
  notification(router);
  organization(router);
  payment(router);
  plan(router);
  subscription(router)
};
