function normalizeProxyPath(value) {
  return String(value || "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
}

function corsHeaders(request) {
  const requestedHeaders = request.headers.get("Access-Control-Request-Headers");
  const requestedMethod = request.headers.get("Access-Control-Request-Method");

  const headers = new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": requestedMethod || "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Max-Age": "86400",
  });

  if (requestedHeaders) {
    headers.set("Access-Control-Allow-Headers", requestedHeaders);
  } else {
    headers.set("Access-Control-Allow-Headers", "*");
  }

  return headers;
}

function parseTarget(requestUrl, proxyPath) {
  const prefix = `/${proxyPath}/`;
  if (!requestUrl.pathname.startsWith(prefix)) {
    return null;
  }

  const remainder = requestUrl.pathname.slice(prefix.length);
  const firstSlash = remainder.indexOf("/");
  const firstSegment = firstSlash === -1
    ? remainder
    : remainder.slice(0, firstSlash);
  const explicitScheme = firstSegment.toLowerCase();
  const hasExplicitScheme = firstSlash !== -1 &&
    (explicitScheme === "http" || explicitScheme === "https");
  const scheme = hasExplicitScheme ? explicitScheme : "https";
  const authorityAndPath = hasExplicitScheme
    ? remainder.slice(firstSlash + 1)
    : remainder;
  const secondSlash = authorityAndPath.indexOf("/");
  const encodedAuthority = secondSlash === -1
    ? authorityAndPath
    : authorityAndPath.slice(0, secondSlash);
  const upstreamPath = secondSlash === -1
    ? "/"
    : authorityAndPath.slice(secondSlash);

  if (!encodedAuthority) {
    throw new Error("Missing upstream host.");
  }

  let authority;
  try {
    authority = decodeURIComponent(encodedAuthority);
  } catch {
    throw new Error("Invalid upstream host encoding.");
  }

  let target;
  try {
    target = new URL(`${scheme}://${authority}${upstreamPath}${requestUrl.search}`);
  } catch {
    throw new Error("Invalid upstream URL.");
  }

  if (target.username || target.password) {
    throw new Error("Credentials in the upstream URL are not supported.");
  }

  return target;
}

function proxiedLocation(location, upstreamUrl, requestUrl, proxyPath) {
  if (!location) {
    return null;
  }

  let redirected;
  try {
    redirected = new URL(location, upstreamUrl);
  } catch {
    return null;
  }

  if (redirected.protocol !== "http:" && redirected.protocol !== "https:") {
    return null;
  }

  const scheme = redirected.protocol.slice(0, -1);
  const authority = encodeURIComponent(redirected.host);
  return `${requestUrl.origin}/${proxyPath}/${scheme}/${authority}${redirected.pathname}${redirected.search}${redirected.hash}`;
}

function upstreamHeaders(request) {
  const headers = new Headers(request.headers);

  // Never forward an inbound Host header or client-supplied forwarding metadata.
  // Cloudflare will construct the proper upstream request metadata for fetch().
  headers.delete("host");
  headers.delete("forwarded");
  headers.delete("x-forwarded-for");
  headers.delete("x-forwarded-host");
  headers.delete("x-forwarded-proto");
  headers.delete("x-real-ip");

  for (const name of [...headers.keys()]) {
    if (name.toLowerCase().startsWith("cf-")) {
      headers.delete(name);
    }
  }

  return headers;
}

async function proxyRequest(request, env) {
  const proxyPath = normalizeProxyPath(env.PROXY_PATH);
  if (!proxyPath) {
    return new Response("PROXY_PATH is not configured.", { status: 500 });
  }

  const requestUrl = new URL(request.url);

  let upstreamUrl;
  try {
    upstreamUrl = parseTarget(requestUrl, proxyPath);
  } catch (error) {
    return new Response(error.message, { status: 400 });
  }

  if (!upstreamUrl) {
    return new Response("Not found.", { status: 404 });
  }

  // Avoid an obvious recursive loop when the Worker URL itself is used as the target.
  if (upstreamUrl.host === requestUrl.host) {
    return new Response("Refusing to proxy to this Worker itself.", { status: 400 });
  }

  if (
    request.method === "OPTIONS" &&
    request.headers.has("Access-Control-Request-Method")
  ) {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(request),
    });
  }

  const init = {
    method: request.method,
    headers: upstreamHeaders(request),
    redirect: "manual",
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(new Request(upstreamUrl.toString(), init));
  } catch (error) {
    return new Response(`Upstream fetch failed: ${error.message}`, { status: 502 });
  }

  // A WebSocket upgrade response must be returned intact so the WebSocket object
  // remains attached to the Response.
  if (upstreamResponse.status === 101 && upstreamResponse.webSocket) {
    return upstreamResponse;
  }

  const responseHeaders = new Headers(upstreamResponse.headers);
  responseHeaders.set("Access-Control-Allow-Origin", "*");
  responseHeaders.set("Access-Control-Expose-Headers", "*");

  const location = proxiedLocation(
    responseHeaders.get("location"),
    upstreamUrl,
    requestUrl,
    proxyPath,
  );
  if (location) {
    responseHeaders.set("location", location);
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}

export default {
  fetch: proxyRequest,
};

