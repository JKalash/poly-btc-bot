import { AuthService } from "./auth";

const pw = process.argv[2];
if (!pw) {
  console.error("usage: pnpm --filter @b5p/api hash-password -- <password>");
  process.exit(1);
}
console.log(await AuthService.hashPassword(pw));
