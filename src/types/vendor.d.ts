declare module 'ws';

declare module 'selfsigned-ca' {
  export type CertOptions = {
    subject?: Record<string, unknown>;
    extensions?: unknown[];
    [key: string]: unknown;
  };

  export class Cert {
    constructor(path: string);
    key: string;
    cert: string;
    caCert: string;
    load(): Promise<void>;
    save(): Promise<void>;
    install(): Promise<void>;
    isInstalled(): Promise<boolean>;
    createRootCa(options: CertOptions): void;
    create(options: CertOptions, rootCaCert: Cert): void;
  }
}

