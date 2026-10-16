import * as docker from "./docker";
import * as k8s from "./kubernetes";
import * as net from "./linux-network";
import * as obs from "./observability";
import type { ShellExperiment, ShellSubject } from "./types";

export const shellExperiments: ShellExperiment[] = [...Object.values(docker), ...Object.values(k8s), ...Object.values(net), ...Object.values(obs)];

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
