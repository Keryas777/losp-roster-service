
export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json(
        {
          status: "ok",
          service: "losp-roster-service",
          version: "0.1.1"
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
