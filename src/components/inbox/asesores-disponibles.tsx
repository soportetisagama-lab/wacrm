'use client';

import { useEffect, useState } from 'react';
import { UsersRound } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import {
  puedeVerAsesoresDisponibles,
  textoAsesoresDisponibles,
  type ResultadoAsesores,
} from '@/lib/asesores-disponibles';
import { cn } from '@/lib/utils';

/** Cada cuánto se vuelve a consultar mientras el chat está abierto. */
const REFRESCO_MS = 60_000;

/**
 * Indicador de la cabecera del chat: asesores a quienes la derivación
 * automática XLR8 podría pasar el chat ahora. Solo para Administrador y
 * ATC (la API también rechaza a los demás). Sin configuración no se
 * muestra; si el PHP falla muestra "No se pudo consultar".
 */
export function AsesoresDisponibles({ className }: { className?: string }) {
  const { accountRole } = useAuth();
  const visible = puedeVerAsesoresDisponibles(accountRole);
  const [resultado, setResultado] = useState<ResultadoAsesores | null>(null);

  useEffect(() => {
    if (!visible) return;
    let activo = true;
    const cargar = async () => {
      try {
        const res = await fetch('/api/xlr8/asesores-disponibles', { cache: 'no-store' });
        if (res.status === 401 || res.status === 403) {
          if (activo) setResultado({ estado: 'no_configurado' });
          return;
        }
        const data = (await res.json().catch(() => null)) as ResultadoAsesores | null;
        if (activo) setResultado(res.ok && data?.estado ? data : { estado: 'error' });
      } catch {
        if (activo) setResultado({ estado: 'error' });
      }
    };
    void cargar();
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void cargar();
    }, REFRESCO_MS);
    return () => {
      activo = false;
      window.clearInterval(id);
    };
  }, [visible]);

  if (!visible || !resultado || resultado.estado === 'no_configurado') return null;

  const texto =
    resultado.estado === 'ok' ? textoAsesoresDisponibles(resultado.asesores) : 'No se pudo consultar';
  const sinAsesor = resultado.estado === 'ok' && resultado.asesores.length === 0;

  return (
    <span
      title={`Derivación automática: ${texto}`}
      className={cn(
        'inline-flex min-w-0 items-center gap-1 truncate',
        sinAsesor && 'text-amber-600',
        className
      )}
    >
      <UsersRound className="h-3 w-3 shrink-0" aria-hidden />
      <span className="truncate">{texto}</span>
    </span>
  );
}
