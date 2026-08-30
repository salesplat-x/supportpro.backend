import { WorkMode } from "../types/enums.js";

export const workModeNeedsLocation = (workMode: string[] | undefined | null): boolean =>
  Boolean(workMode?.includes(WorkMode.Hybrid) || workMode?.includes(WorkMode.OnSite));
