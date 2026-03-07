import { appendLogLine } from "@/services/logger";

export const login = async (username: string, password: string) => {
  const response = await fetch(`${process.env.NEXT_PUBLIC_ELASTICDASH_API}/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ username, password }),
  });

  appendLogLine(`authService - POST /auth/login: status=${response.status}`);

  if (!response.ok) {
    throw new Error("Login failed");
  }

  return response.json();
};

export const validateToken = async (token: string) => {
  const response = await fetch(`${process.env.NEXT_PUBLIC_ELASTICDASH_API}/user/account`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  appendLogLine(`authService - GET /user/account: status=${response.status}`);

  if (!response.ok) {
    throw new Error("Token validation failed");
  }

  return response.json();
};