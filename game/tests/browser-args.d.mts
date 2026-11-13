export function browserArgs(extraArgs?: readonly string[], options?: {
  platform?: NodeJS.Platform;
  softwareGL?: string;
  gpu?: string;
}): string[];
