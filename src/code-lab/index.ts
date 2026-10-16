import * as kafka from "./kafka";
import * as postgres from "./postgres";
import * as ai from "./ai";
import * as chaos from "./chaos";
import * as obs from "./observability";
import * as cdc from "./cdc";
import * as search from "./search";
import * as dbi from "./db-internals";
import * as api from "./api-design";
import * as mq from "./messaging";
import * as mlops from "./mlops";
import * as testing from "./testing";
import * as ds from "./distributed";
import type { CodeExperiment, CodeSubject } from "./types";

export const codeExperiments: CodeExperiment[] = [
  ...Object.values(kafka).filter((v): v is CodeExperiment => typeof v === "object" && v !== null && "run" in v),
  ...Object.values(postgres).filter((v): v is CodeExperiment => typeof v === "object" && v !== null && "run" in v),
  ...Object.values(ai).filter((v): v is CodeExperiment => typeof v === "object" && v !== null && "run" in v),
  ...Object.values(chaos).filter((v): v is CodeExperiment => typeof v === "object" && v !== null && "run" in v),
  ...Object.values(obs).filter((v): v is CodeExperiment => typeof v === "object" && v !== null && "run" in v),
  ...Object.values(cdc).filter((v): v is CodeExperiment => typeof v === "object" && v !== null && "run" in v),
  ...[search, dbi, api, mq, mlops, testing, ds].flatMap((m) => Object.values(m as Record<string, unknown>).filter((v): v is CodeExperiment => typeof v === "object" && v !== null && "run" in v)),
];

export function listCodeExperiments(subject: CodeSubject | string): CodeExperiment[] {
  return codeExperiments.filter((e) => e.subject === subject);
}

export function getCodeExperiment(subject: string, id: string): CodeExperiment | undefined {
  return codeExperiments.find((e) => e.subject === subject && e.id === id);
}

export type { CodeExperiment, CodeResult, CodeSubject } from "./types";
