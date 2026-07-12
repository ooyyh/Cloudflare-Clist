import { createRequestHandler, type AppLoadContext } from "react-router";

declare module "react-router" {
  export interface AppLoadContext {
    cloudflare: {
      env: Env;
      ctx: ExecutionContext;
    };
  }
}

const getServerBuild = () => import("virtual:react-router/server-build");

const requestHandler = createRequestHandler(getServerBuild, import.meta.env.MODE);

async function handleWebdavRequest(
  request: Request,
  params: { storageId: string; "*": string },
  context: AppLoadContext
): Promise<Response> {
  const build = await getServerBuild();
  const route = build.routes["routes/dav.$storageId.$"];
  const module = route?.module as
    | { handleWebdavRequest?: (request: Request, params: { storageId: string; "*": string }, context: AppLoadContext) => Promise<Response> }
    | undefined;
  const handler = module?.handleWebdavRequest;
  if (typeof handler !== "function") {
    return new Response("WebDAV handler not found", { status: 500 });
  }
  return handler(request, params, context);
}

function getWebdavParams(request: Request): { storageId: string; "*": string } | null {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/dav\/([^/]+)\/?(.*)$/);
  if (!match) {
    return null;
  }
  const rawPath = match[2] || "";
  const decodedPath = rawPath
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");

  return {
    storageId: match[1],
    "*": decodedPath,
  };
}

export default {
  async fetch(request, env, ctx) {
    const webdavParams = getWebdavParams(request);
    if (webdavParams) {
      return handleWebdavRequest(request, webdavParams, {
        cloudflare: { env, ctx },
      });
    }

    return requestHandler(request, {
      cloudflare: { env, ctx },
    });
  },
} satisfies ExportedHandler<Env>;
