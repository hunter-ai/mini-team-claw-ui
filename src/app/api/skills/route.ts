import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getDictionary } from "@/lib/i18n/dictionary";
import { resolveRequestLocale } from "@/lib/i18n/request-locale";
import { OpenClawGatewayError } from "@/lib/openclaw/gateway";
import { listGatewaySkills } from "@/lib/skills";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const locale = await resolveRequestLocale(request);
  const messages = await getDictionary(locale);
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: messages.auth.unauthorized }, { status: 401 });
  }

  try {
    const skills = await listGatewaySkills();

    return NextResponse.json({
      skills,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    let message: string = messages.chat.skillsUnavailable;

    if (error instanceof OpenClawGatewayError) {
      if (error.message.includes("connect")) {
        message = messages.chat.skillsConnectionFailed;
      } else if (error.message.includes("skills.status")) {
        message = messages.chat.skillsApiUnavailable;
      } else {
        message = messages.chat.skillsUnavailable;
      }
    }

    return NextResponse.json({ error: message }, { status: 503 });
  }
}
