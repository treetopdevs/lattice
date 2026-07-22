export interface IosSigningRedactionOptions {
  developmentTeam?: string;
  deviceUdid?: string;
  home?: string;
}

export function redactIosSigningOutput(
  output: string,
  options?: IosSigningRedactionOptions,
): string;
