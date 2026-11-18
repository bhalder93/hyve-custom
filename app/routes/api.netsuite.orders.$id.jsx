import {
  CORS_HEADERS,
  handleSingleOrderRequest,
} from "../lib/orders-api.server.js";

export const headers = () => CORS_HEADERS;

export const loader = async ({ request, params }) => {
  return handleSingleOrderRequest({ request, params });
};

export const action = async ({ request, params }) => {
  return handleSingleOrderRequest({ request, params });
};
