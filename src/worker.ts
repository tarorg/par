import { Env, ListResponse } from './types';
import { handleOptions, addCorsHeaders } from './cors';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return handleOptions();
    }

    try {
      const url = new URL(request.url);
      const key = decodeURIComponent(url.pathname.slice(1));

      let response: Response;

      switch (request.method) {
        case 'GET':
          if (key === 'list') {
            const cursor = url.searchParams.get('cursor');
            const prefix = url.searchParams.get('prefix');
            const limit = url.searchParams.get('limit');
            response = await handleList(env, prefix, cursor, limit);
          } else {
            response = await handleGet(env, key);
          }
          break;

        case 'POST':
          if (key === 'multipart') {
            response = await handleMultipartUpload(request, env);
          } else {
            response = new Response('Invalid endpoint', { status: 400 });
          }
          break;

        case 'PUT':
          response = await handlePut(request, key, env);
          break;

        case 'DELETE':
          response = await handleDelete(key, env);
          break;

        default:
          response = new Response('Method not allowed', { status: 405 });
      }

      return addCorsHeaders(response);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error occurred';
      const errorResponse = new Response(`Error: ${message}`, { status: 500 });
      return addCorsHeaders(errorResponse);
    }
  },
};

async function handleList(
  env: Env, 
  prefix?: string | null, 
  cursor?: string | null, 
  limit?: string | null
): Promise<Response> {
  const options: R2ListOptions = {
    prefix: prefix ?? undefined,
    cursor: cursor ?? undefined,
    limit: limit ? parseInt(limit) : undefined,
  };

  const listed = await env.MY_BUCKET.list(options);
  
  const response: ListResponse = {
    objects: listed.objects.map(obj => ({
      name: obj.key,
      size: obj.size,
      uploaded: obj.uploaded.toISOString(),
      type: obj.httpMetadata?.contentType,
    })),
    truncated: listed.truncated,
    cursor: listed.truncated ? listed.cursor : undefined,
  };

  return new Response(JSON.stringify(response), {
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

async function handleGet(env: Env, key: string): Promise<Response> {
  const object = await env.MY_BUCKET.get(key);

  if (!object) {
    return new Response('Object Not Found', { status: 404 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('Cache-Control', 'public, max-age=31536000');

  return new Response(object.body, {
    headers,
  });
}

async function handlePut(request: Request, key: string, env: Env): Promise<Response> {
  try {
    // Handle form data upload
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const fileName = formData.get('name') as string | null;

    if (!file) {
      return new Response('No file provided', { status: 400 });
    }

    // Use provided name or fall back to the uploaded file's name
    const finalKey = fileName || file.name || key;
    const contentType = file.type || 'application/octet-stream';
    const contentLength = file.size.toString();

    if (parseInt(contentLength) > 100_000_000) { // 100MB limit
      return new Response('File too large. Use multipart upload for files over 100MB.', { status: 413 });
    }

    const object = await env.MY_BUCKET.put(finalKey, file.stream(), {
      httpMetadata: {
        contentType,
      },
    });

    return new Response(JSON.stringify({
      key: finalKey,
      etag: object.httpEtag,
      size: parseInt(contentLength),
      type: contentType
    }), {
      headers: {
        'Content-Type': 'application/json',
      },
    });
  } catch (error) {
    return new Response(`Upload failed: ${error.message}`, { status: 400 });
  }
}

async function handleMultipartUpload(request: Request, env: Env): Promise<Response> {
  const { key, uploadId, partNumber, parts } = await request.json<{
    key: string;
    uploadId?: string;
    partNumber?: number;
    parts?: { partNumber: number; etag: string }[];
  }>();

  if (!uploadId) {
    const upload = await env.MY_BUCKET.createMultipartUpload(key);
    return new Response(JSON.stringify({ uploadId: upload.uploadId }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (partNumber !== undefined) {
    if (!request.body) {
      return new Response('Request body is required', { status: 400 });
    }
    
    const upload = await env.MY_BUCKET.resumeMultipartUpload(key, uploadId);
    const part = await upload.uploadPart(partNumber, request.body);
    
    return new Response(JSON.stringify({ 
      etag: part.etag,
      partNumber 
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (parts) {
    const upload = await env.MY_BUCKET.resumeMultipartUpload(key, uploadId);
    const object = await upload.complete(parts);
    
    return new Response(JSON.stringify({
      key,
      etag: object.httpEtag
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  return new Response('Invalid multipart upload request', { status: 400 });
}

async function handleDelete(key: string, env: Env): Promise<Response> {
  await env.MY_BUCKET.delete(key);
  return new Response(JSON.stringify({ deleted: key }), {
    headers: {
      'Content-Type': 'application/json',
    },
  });
} 