import { Router } from "express";

import main from "./main";
import auth from "./auth";
import job from "./job";
import role from "./role";
import user from "./user";
import upload from "./upload";
import question from "./question";
import organization from "./organization";

export default (router: Router) => {
  main(router);
  auth(router);
  user(router);
  job(router);
  role(router);
  upload(router);
  question(router);
  organization(router);
};
