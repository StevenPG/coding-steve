// Send the bare production pages.dev hosts to the custom domain so they don't
// compete with stevenpg.com in search results. Preview deployments
// (<branch>.stevenpg.pages.dev, <commit>.stevenpg.pages.dev) are left alone so
// they can be reviewed; Cloudflare already marks them noindex.
const PRODUCTION_PAGES_HOSTS = new Set([
  "stevenpg.pages.dev",
  "coding-steve.pages.dev",
]);

export async function onRequest({ request, next }) {
  const url = new URL(request.url);

  if (PRODUCTION_PAGES_HOSTS.has(url.hostname)) {
    url.hostname = "stevenpg.com";
    url.protocol = "https:";
    url.port = "";
    return Response.redirect(url.toString(), 301);
  }

  return next();
}
