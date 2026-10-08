
export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return Response.redirect(new URL("/index.html", url), 302);
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json(
        {
          status: "ok",
          service: "losp-roster-service",
          version: "0.1.2"
        },
        {
          headers: {
            "Cache-Control": "no-store"
          }
        }
      );
    }

    return new Response("Not Found", {
      status: 404
    });
  }
};
