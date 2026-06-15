import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);

  const code = requestUrl.searchParams.get("code");

  if (code) {
    const supabase = await createClient();

    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      return NextResponse.redirect(new URL("/dashboard", requestUrl.origin));
    }

    return NextResponse.redirect(
        new URL(
            `/auth/error?error=${encodeURIComponent(error.message)}`,
            requestUrl.origin
        )
    );
  }

  return NextResponse.redirect(
      new URL(
          "/auth/error?error=No confirmation code found",
          requestUrl.origin
      )
  );
}