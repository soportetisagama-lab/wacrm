import type { ComponentProps, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';

// The rounded, icon-prefixed input shared by every auth form. Pass
// `endAdornment` for a trailing control (e.g. the show/hide password
// toggle) — it also reserves right padding so the text never runs
// under it.
export function AuthInput({
  icon: Icon,
  endAdornment,
  className,
  ...props
}: {
  icon: LucideIcon;
  endAdornment?: ReactNode;
} & Omit<ComponentProps<typeof Input>, 'className'> & { className?: string }) {
  return (
    <div className="relative">
      <Icon className="text-muted-foreground pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2" />
      <Input
        {...props}
        className={cn(
          'border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20 h-12 rounded-2xl pl-10',
          endAdornment && 'pr-10',
          className
        )}
      />
      {endAdornment}
    </div>
  );
}
