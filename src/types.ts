export interface Env {
  MY_BUCKET: R2Bucket;
}

export interface ListResponse {
  objects: {
    name: string;
    size: number;
    uploaded: string;
    type?: string;
  }[];
  truncated: boolean;
  cursor?: string;
} 