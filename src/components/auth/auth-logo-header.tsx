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
      <Image
        src="/branding/BIENVENIDO.png"
        alt="Bienvenido a Sagama Inox"
        width={862}
        height={134}
        priority
        className="h-auto w-full max-w-[380px]"
      />
      {title && (
        <h1 className="text-foreground text-lg font-semibold">{title}</h1>
      )}
      {subtitle && <p className="text-muted-foreground text-sm">{subtitle}</p>}
    </div>
  );
}
