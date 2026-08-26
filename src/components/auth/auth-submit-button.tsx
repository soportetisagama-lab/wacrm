import type { ComponentProps, ReactNode } from 'react';
import { ArrowRight } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

// The primary call-to-action button shared by every auth form: brand
// blue, uppercase label, arrow that nudges forward on hover, and a
// diagonal shimmer sweep — all pure CSS/Tailwind, no JS animation loop.
export function AuthSubmitButton({
  loading,
  loadingLabel,
  children,
  className,
  ...props
}: {
  loading?: boolean;
  loadingLabel: string;
  children: ReactNode;
} & Omit<ComponentProps<typeof Button>, 'className' | 'children'> & {
    className?: string;
  }) {
  return (
    <Button
      type="submit"
      disabled={loading}
      {...props}
      className={cn(
        'group/button bg-primary text-primary-foreground shadow-primary/30 hover:bg-primary relative mt-1 h-12 w-full overflow-hidden rounded-2xl text-sm font-semibold tracking-wide uppercase shadow-lg disabled:opacity-60',
        className
      )}
    >
      <span className="relative z-10">{loading ? loadingLabel : children}</span>
      <ArrowRight className="relative z-10 h-4 w-4 transition-transform group-hover/button:translate-x-1" />
      <span className="pointer-events-none absolute inset-y-0 -left-1/2 w-1/2 -skew-x-12 bg-white/25 transition-[left] duration-500 ease-out group-hover/button:left-[150%]" />
    </Button>
  );
}
