import type { Experiment, Category } from "./types";
import * as dataTypes from "./01-data-types";
import * as atomicity from "./02-atomicity";
import * as messaging from "./03-messaging";
import * as patterns from "./04-patterns";
import * as ha from "./05-ha";
import * as advanced from "./06-advanced";
import * as modules from "./07-modules";

export const experiments: Experiment[] = [
  ...Object.values(dataTypes),
  ...Object.values(atomicity),
  ...Object.values(messaging),
  ...Object.values(patterns),
  ...Object.values(ha),
  ...Object.values(advanced),
  ...Object.values(modules),
];

export const categories: Category[] = ["자료구조", "원자성·동시성", "메시징", "패턴·활용", "내부 동작", "고가용성", "모듈 (Redis 8)"];

export function getExperiment(id: string): Experiment | undefined {
  return experiments.find((e) => e.id === id);
}

export type { Experiment, ExperimentResult, RunContext } from "./types";
