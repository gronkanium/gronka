export default {
  fetch(req) {
    const url = new URL(req.url);
    url.hostname = 'gronka.dev';
    return Response.redirect(url.toString(), 301);
  },
};
