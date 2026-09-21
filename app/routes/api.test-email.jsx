import { sendMail } from "../lib/email/mailer.server";

export async function loader() {
  try {
    const result = await sendMail({
      to: "bilash.halder@somnetics.in",
      subject: "HYVE Dev Email Test",
      text: "SMTP is working.",
      html: "<strong>SMTP is working.</strong>",
    });

    return Response.json({
      ok: true,
      result,
    });
  } catch (error) {
    console.error(error);

    return Response.json(
      {
        ok: false,
        error: error.message,
      },
      {
        status: 500,
      },
    );
  }
}