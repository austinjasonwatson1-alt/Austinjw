import { Inbox } from "@/components/Inbox";
import { Nav } from "@/components/Nav";

export const metadata = { title: "Inbox · Writer's Room" };

export default function InboxPage() {
  return (
    <>
      <main>
        <Inbox />
      </main>
      <Nav />
    </>
  );
}
