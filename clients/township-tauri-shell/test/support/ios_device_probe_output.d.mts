export function completeProbeLines(output: string, prefix: string): string[];

export function createIosProbeCopyDestination(
  root: string,
  launch: number,
  attempt: number,
): string;

export function secureIosProbeCopy(path: string): void;

export function iosDeviceLaunchProcessId(value: unknown): string;

export interface IosDeviceProbeRecord {
  fields: Record<string, string>;
  line: string;
}

export interface IosDeviceProbeEvidence {
  control: IosDeviceProbeRecord;
  launchNonce: string;
  primary: IosDeviceProbeRecord;
  processId: string;
  startup: IosDeviceProbeRecord;
}

export interface IosDeviceProbeProgress {
  evidence: IosDeviceProbeEvidence | undefined;
  launchNonce: string | undefined;
  processId: string | undefined;
}

export function iosDeviceProbeProgress(
  output: string,
  prefix: string,
  expectedLaunchNonce: string,
  expectedProcessId: string,
): IosDeviceProbeProgress;

export function redactIosDeviceCommandOutput(
  value: string,
  deviceUdid?: string,
  home?: string,
  deviceName?: string,
): string;
