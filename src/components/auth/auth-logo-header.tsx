import Image from 'next/image';

// Shared header for the "form" state of each auth screen: the Sagama
// Inox wordmark, an optional bold heading, and an optional description
// line.
export function AuthLogoHeader({
  title,
  subtitle,
}: {
  title?: string;
  subtitle?: string;
}) {
  return (
    <div className="mb-8 flex flex-col items-center gap-2 text-center">
      {/* The card's own padding (AuthCard's px-8/sm:px-12), not this
          max-w cap, is what actually bounds the rendered width today —
          352px on desktop, well under the 380px cap. A small negative
          margin lets the wordmark bleed past that padding so it can
          actually grow (~10-14%) instead of the cap silently doing
          nothing. */}
      <Image
        src="/branding/BIENVENIDO-Retail.png"
        alt="Bienvenido a Sagama Inox"
        width={862}
        height={134}
        priority
        className="-mx-4 h-auto w-[calc(100%+2rem)] max-w-none sm:-mx-6 sm:w-[calc(100%+3rem)]"
      />
      {title && (
        <h1 className="text-foreground text-lg font-semibold">{title}</h1>
      )}
      {subtitle && <p className="text-muted-foreground text-sm">{subtitle}</p>}
    </div>
  );
}
