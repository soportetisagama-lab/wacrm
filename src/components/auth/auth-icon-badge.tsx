import type { LucideIcon } from 'lucide-react';

// Circular icon badge used by the "success" state of each auth screen
// (email sent / check your inbox), sitting inside an AuthCard.
export function AuthIconBadge({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <div className="bg-primary/15 text-primary mb-4 flex h-14 w-14 items-center justify-center rounded-2xl">
      <Icon className="h-7 w-7" />
    </div>
  );
}
