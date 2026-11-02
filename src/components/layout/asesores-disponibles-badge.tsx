"use client";

import { useEffect, useState } from "react";
import { TriangleAlert, UsersRound } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  puedeVerAsesoresDisponibles,
  textoContadorAsesores,
  type ResultadoAsesores,
} from "@/lib/asesores-disponibles";
import { cn } from "@/lib/utils";

/** Cada cuánto se vuelve a consultar mientras la pestaña está visible. */
const REFRESCO_MS = 60_000;

/**
 * Contador de asesores disponibles para la derivación automática XLR8,
 * junto a la píldora del número de la línea. Al tocarlo abre la fila en
 * el orden en que el PHP los reparte (el primero recibe el próximo
 * chat). Solo Administrador y ATC: para cualquier otro rol no se
 * renderiza ni se consulta la API. Sin configuración no se muestra.
 */
export function AsesoresDisponiblesBadge() {
  const { accountRole } = useAuth();
  const visible = puedeVerAsesoresDisponibles(accountRole);
  const [resultado, setResultado] = useState<ResultadoAsesores | null>(null);

  useEffect(() => {
    if (!visible) return;
    let activo = true;
    const cargar = async () => {
      try {
        const res = await fetch("/api/xlr8/asesores-disponibles", { cache: "no-store" });
        if (res.status === 401 || res.status === 403) {
          if (activo) setResultado({ estado: "no_configurado" });
          return;
        }
        const data = (await res.json().catch(() => null)) as ResultadoAsesores | null;
        if (activo) setResultado(res.ok && data?.estado ? data : { estado: "error" });
      } catch {
        if (activo) setResultado({ estado: "error" });
      }
    };
    void cargar();
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void cargar();
    }, REFRESCO_MS);
    return () => {
      activo = false;
      window.clearInterval(id);
    };
  }, [visible]);

  if (!visible || !resultado || resultado.estado === "no_configurado") return null;

  const error = resultado.estado === "error";
  const asesores = resultado.estado === "ok" ? resultado.asesores : [];
  const cantidad = asesores.length;
  const texto = error ? "No se pudo consultar" : textoContadorAsesores(cantidad);

  return (
    <Popover>
      <PopoverTrigger
        aria-label={`Asesores disponibles: ${texto}. Toca para ver la fila.`}
        title={`Derivación automática: ${texto}`}
        className={cn(
          "flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-white/15 px-2.5 text-xs font-medium whitespace-nowrap text-white/90 transition-colors hover:bg-white/25 focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-none data-popup-open:bg-white/25 sm:h-9 sm:px-3 sm:text-sm",
          error && "text-white/70",
          !error && cantidad === 0 && "ring-1 ring-white/50"
        )}
      >
        {error ? (
          <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
        ) : (
          <UsersRound className="h-3.5 w-3.5 shrink-0" aria-hidden />
        )}
        {error ? (
          <span className="sr-only">{texto}</span>
        ) : (
          <>
            {/* Móvil: solo el número; desde sm: "3 asesores" / "Sin asesor". */}
            <span className="tabular-nums sm:hidden">{cantidad}</span>
            <span className="hidden tabular-nums sm:inline">{texto}</span>
          </>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-64">
        <PopoverHeader>
          <PopoverTitle>Asesores disponibles</PopoverTitle>
          <PopoverDescription className="text-xs">
            {error
              ? "No se pudo consultar la fila. Se reintenta en un minuto."
              : cantidad === 0
                ? "Ahora no hay asesor para la derivación automática."
                : "En orden de reparto: el primero recibe el próximo chat."}
          </PopoverDescription>
        </PopoverHeader>
        {cantidad > 0 && (
          <ol className="flex max-h-72 flex-col gap-1 overflow-y-auto">
            {asesores.map((asesor, i) => (
              <li
                key={asesor.id}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2 py-1.5",
                  i === 0 && "bg-accent text-accent-foreground"
                )}
              >
                <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[11px] font-semibold text-primary-foreground tabular-nums">
                  {i + 1}
                </span>
                <span className="truncate">{asesor.nombre || `Asesor ${asesor.id}`}</span>
                {i === 0 && (
                  <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">Siguiente</span>
                )}
              </li>
            ))}
          </ol>
        )}
      </PopoverContent>
    </Popover>
  );
}
