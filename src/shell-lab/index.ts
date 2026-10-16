import * as docker from "./docker";
import * as k8s from "./kubernetes";
import * as net from "./linux-network";
import * as obs from "./observability";
import * as security from "./security";
import * as iac from "./iac";
import * as perf from "./performance";
import * as sre from "./sre";
import * as ebpf from "./ebpf";
import * as finops from "./finops";
import * as osi from "./os-internals";
import type { ShellExperiment, ShellSubject } from "./types";

const isExp = (v: unknown): v is ShellExperiment => typeof v === "object" && v !== null && "run" in v && "subject" in v;
export const shellExperiments: ShellExperiment[] = [docker, k8s, net, obs, security, iac, perf, sre, ebpf, finops, osi].flatMap((m) => Object.values(m as Record<string, unknown>).filter(isExp));

export function listShellExperiments(subject: ShellSubject): ShellExperiment[] {
  return shellExperiments.filter((e) => e.subject === subject);
}

export function getShellExperiment(subject: string, id: string): ShellExperiment | undefined {
  return shellExperiments.find((e) => e.subject === subject && e.id === id);
}

export function shellCategories(subject: ShellSubject): string[] {
  return [...new Set(listShellExperiments(subject).map((e) => e.category))];
}

export type { ShellExperiment, ShellResult, ShellStep, ShellSubject } from "./types";
