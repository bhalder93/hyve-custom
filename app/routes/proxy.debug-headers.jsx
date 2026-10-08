export const loader = ({ request }) => {
  const headers = {};
  for (const [key, value] of request.headers.entries()) {
    headers[key] = value;
  }
  return new Response(JSON.stringify(headers, null, 2), {
    headers: { "content-type": "application/json" }
  });
};
