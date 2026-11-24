import { signOut } from "@/app/actions/auth";

export function SignOut({ className }: { className?: string }) {
  return (
    <form action={signOut} className={className}>
      <button
        type="submit"
        className="block w-full rounded-sm px-2.5 py-1.5 text-left text-sm text-secondary hover:bg-surface hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        Sign out
      </button>
    </form>
  );
}
