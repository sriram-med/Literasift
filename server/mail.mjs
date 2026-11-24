// Minimal SMTP client (implicit TLS, usually port 465, AUTH PLAIN) so invites and password resets can be emailed without dependencies.
import tls from "node:tls";

export const mailConfigured = env => Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.MAIL_FROM);
const clean = value => String(value).replace(/[\r\n]+/g, " ").trim();

export function sendMail(env, { to, subject, text }) {
  const recipient = clean(to), from = clean(env.MAIL_FROM);
  if (!/^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(recipient)) return Promise.reject(new Error("Invalid recipient."));
  const address = /<([^>]+)>/.exec(from)?.[1] || from;
  const body = Buffer.from(text, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
  const message = [`From: ${from}`, `To: ${recipient}`, `Subject: =?UTF-8?B?${Buffer.from(clean(subject)).toString("base64")}?=`, `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@${address.split("@")[1] || "localhost"}>`, "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", body].join("\r\n");
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: env.SMTP_HOST, port: Number(env.SMTP_PORT || 465), servername: env.SMTP_HOST });
    let buffer = "", waiting = null, done = false;
    const finish = error => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(); };
    const timer = setTimeout(() => finish(new Error("SMTP timed out.")), 25000);
    socket.setEncoding("utf8");
    socket.on("error", finish);
    socket.on("close", () => finish(new Error("SMTP connection closed.")));
    socket.on("data", chunk => {
      buffer += chunk;
      const lines = buffer.split("\r\n");
      if (lines.length < 2) return;
      const complete = lines.slice(0, -1);
      const last = complete[complete.length - 1];
      if (/^\d{3} /.test(last) && waiting) { buffer = lines[lines.length - 1]; const w = waiting; waiting = null; w(last); }
    });
    const expect = () => new Promise(r => { waiting = r; });
    const step = async (command, code) => {
      if (command !== null) socket.write(command + "\r\n");
      const reply = await expect();
      if (!reply.startsWith(code)) throw new Error("SMTP error: " + reply.slice(0, 80));
    };
    socket.on("secureConnect", async () => {
      try {
        await step(null, "220");
        await step("EHLO " + (address.split("@")[1] || "localhost"), "250");
        await step("AUTH PLAIN " + Buffer.from(`\0${env.SMTP_USER}\0${env.SMTP_PASS}`).toString("base64"), "235");
        await step(`MAIL FROM:<${address}>`, "250");
        await step(`RCPT TO:<${recipient}>`, "250");
        await step("DATA", "354");
        await step(message.replace(/^\./gm, "..") + "\r\n.", "250");
        socket.write("QUIT\r\n");
        finish();
      } catch (error) { finish(error); }
    });
  });
}
