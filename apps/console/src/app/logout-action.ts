"use server";

import { redirect } from "next/navigation";
import { logout } from "../lib/auth";

/** 退出登录 Server Action */
export async function logoutAction() {
  await logout();
  redirect("/login");
}
