import { describe, expect, it } from 'vitest';

import { buildEventId } from './event-id';
import {
  META_CAPI_EVENT_NAMES,
  buildEventPayload,
  buttonMetaEvent,
  clampEventTime,
  datasetCreateBody,
  datasetNameFromEnv,
  datasetRenameNeeded,
  decideAwaitingPurchase,
  dedupKeyFor,
  eventForTag,
  isMetaCapiEventName,
  isQuoteDocument,
  nextRetryDelayMs,
  parseMonto,
  parseQualifiedTags,
  parseVentasResponse,
  isPurchaseCovered,
  isUnsendablePurchase,
  parseXlr8Fecha,
  pickVenta,
  purchaseValueDeadline,
  purchaseCoveringVenta,
  ventaMatchesClosure,
} from './events';
import { validateInteractivePayload } from '@/lib/whatsapp/interactive';
import en from '../../../messages/en.json';
import es from '../../../messages/es.json';
import ko from '../../../messages/ko.json';

describe('eventForTag', () => {
  const inox = parseQualifiedTags('PROYECTO');
  const castor = parseQualifiedTags(' producto , PROYECTO ');
  const industrial = parseQualifiedTags('');

  it('maps status tags', () => {
    expect(eventForTag('ANTICIPO', inox)).toBe('OrderCreated');
    expect(eventForTag('cerrado', inox)).toBe('Purchase');
    expect(eventForTag('CERRADO 0', inox)).toBeNull();
    for (const t of ['CAIDO', 'SPAM', 'INFO', 'SEGUIMIENTO', 'ASIGNADO']) {
      expect(eventForTag(t, castor)).toBeNull();
    }
  });

  it('maps type tags per line config', () => {
    expect(eventForTag('PROYECTO', inox)).toBe('QualifiedLead');
    expect(eventForTag('PRODUCTO', inox)).toBeNull();
    expect(eventForTag('producto', castor)).toBe('QualifiedLead');
    expect(eventForTag('PROYECTO', industrial)).toBeNull();
  });
});

describe('dedup', () => {
  it('one key per event, Purchase per project', () => {
    expect(dedupKeyFor('LeadSubmitted')).toBe('LeadSubmitted');
    expect(dedupKeyFor('QualifiedLead', { projectId: 9 })).toBe('QualifiedLead');
    expect(dedupKeyFor('Purchase')).toBe('Purchase');
    expect(dedupKeyFor('Purchase', { projectId: 123 })).toBe('Purchase:123');
    expect(dedupKeyFor('Purchase', { projectId: ' ' })).toBe('Purchase');
  });

  it('event_id is stable per (account, contact, key) and unique otherwise', () => {
    const a = buildEventId('acc', 'c1', 'Purchase:1');
    expect(buildEventId('acc', 'c1', 'Purchase:1')).toBe(a);
    expect(buildEventId('acc', 'c1', 'Purchase:2')).not.toBe(a);
    expect(buildEventId('acc', 'c2', 'Purchase:1')).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{40}$/);
  });

  it('pickVenta takes the newest unsent project', () => {
    const v = (projectId: string, fecha: string) => ({
      celular: '51900000000',
      projectId,
      monto: 10,
      fecha: new Date(fecha),
    });
    const now = new Date('2026-11-07T00:00:00Z');
    const ventas = [v('1', '2026-11-01'), v('2', '2026-11-05'), v('0', '2026-10-01')];
    expect(pickVenta(ventas, new Set(), now)?.projectId).toBe('2');
    expect(pickVenta(ventas, new Set(['2']), now)?.projectId).toBe('1');
    // A sale older than 7 days belongs to a past closure.
    expect(pickVenta(ventas, new Set(['1', '2']), now)).toBeNull();
  });

  it('pickVenta measures the window from the closure, not from now', () => {
    // Real case: sale dated 2-nov (noon Lima), CERRADO on 3-nov 13:59 UTC,
    // CAPI switched on 9-nov 21:12 UTC (more than 7 days after the sale).
    const sale = { celular: '51900000000', projectId: '42', monto: 710, fecha: parseXlr8Fecha('2026-11-02') };
    const closedAt = new Date('2026-11-03T13:59:00Z');
    expect(pickVenta([sale], new Set(), closedAt)?.projectId).toBe('42');
    // Already sent → never repeated.
    expect(pickVenta([sale], new Set(['42']), closedAt)).toBeNull();
    // Measured from now (old behavior) it would have been lost.
    expect(pickVenta([sale], new Set(), new Date('2026-11-09T21:12:00Z'))).toBeNull();
  });

  it('a Purchase already sent without project covers the sale found later', () => {
    const sale = { celular: '51900000000', projectId: '42', monto: 710, fecha: parseXlr8Fecha('2026-11-02') };
    const closedAt = new Date('2026-11-03T13:59:00Z');
    const sentNoProject = { id: 's', projectId: null, eventTime: closedAt };
    // The sale is found (not among sent project ids, since that one is null)…
    const found = pickVenta([sale], new Set(), closedAt);
    expect(found?.projectId).toBe('42');
    // …but the projectless Purchase of that closure covers it: no second one.
    expect(purchaseCoveringVenta(found!, [sentNoProject])?.id).toBe('s');
    // A projectless Purchase of another closure (weeks earlier) does not.
    expect(purchaseCoveringVenta(found!, [{ id: 'o', projectId: null, eventTime: new Date('2026-10-01T00:00:00Z') }])).toBeNull();
    // One with a project is matched by project id, not by this rule.
    expect(purchaseCoveringVenta(found!, [{ id: 'p', projectId: '41', eventTime: closedAt }])).toBeNull();
  });

  it('a sale belongs to a closure from 7 days before up to 2 days after it', () => {
    const closedAt = new Date('2026-11-10T00:00:00Z');
    expect(ventaMatchesClosure(new Date('2026-11-03T01:00:00Z'), closedAt)).toBe(true);
    expect(ventaMatchesClosure(new Date('2026-11-02T23:00:00Z'), closedAt)).toBe(false);
    expect(ventaMatchesClosure(new Date('2026-11-11T23:00:00Z'), closedAt)).toBe(true);
    expect(ventaMatchesClosure(new Date('2026-11-12T01:00:00Z'), closedAt)).toBe(false);
    expect(ventaMatchesClosure(null, closedAt)).toBe(true);
  });

  it('a waiting Purchase yields to another recent Purchase of the contact', () => {
    const now = new Date('2026-11-09T00:00:00Z');
    const mine = { id: 'w', createdAt: now };
    expect(isPurchaseCovered('w', [mine], now)).toBe(false);
    expect(isPurchaseCovered('w', [mine, { id: 'p', createdAt: new Date('2026-11-08T00:00:00Z') }], now)).toBe(true);
    expect(isPurchaseCovered('w', [mine, { id: 'old', createdAt: new Date('2026-10-01T00:00:00Z') }], now)).toBe(false);
  });
});

describe('buildEventPayload', () => {
  const base = {
    eventTime: new Date('2026-11-09T15:00:00Z'),
    eventId: 'evt1',
    wabaId: 'waba1',
    ctwaClid: 'clid1',
  };

  it('builds a business_messaging event with only ctwa_clid + WABA', () => {
    const body = buildEventPayload({ ...base, eventName: 'LeadSubmitted' });
    expect(body).toEqual({
      data: [
        {
          event_name: 'LeadSubmitted',
          event_time: Math.floor(base.eventTime.getTime() / 1000),
          event_id: 'evt1',
          action_source: 'business_messaging',
          messaging_channel: 'whatsapp',
          user_data: { whatsapp_business_account_id: 'waba1', ctwa_clid: 'clid1' },
        },
      ],
    });
  });

  it('adds value + PEN for a Purchase with amount, omits it without', () => {
    const withValue = buildEventPayload({ ...base, eventName: 'Purchase', value: 1500.5, currency: 'PEN' });
    expect(withValue.data[0].custom_data).toEqual({ value: 1500.5, currency: 'PEN' });
    const noValue = buildEventPayload({ ...base, eventName: 'Purchase', value: null });
    expect(noValue.data[0]).not.toHaveProperty('custom_data');
  });

  it('never sends a Purchase without value', () => {
    expect(isUnsendablePurchase('Purchase', null)).toBe(true);
    expect(isUnsendablePurchase('Purchase', 0)).toBe(true);
    expect(isUnsendablePurchase('Purchase', '1500.00')).toBe(false);
    expect(isUnsendablePurchase('LeadSubmitted', null)).toBe(false);
  });

  it('clamps event time to Meta’s 7-day window', () => {
    const now = new Date('2026-11-09T00:00:00Z');
    expect(clampEventTime(new Date('2026-11-10T00:00:00Z'), now)).toEqual(now);
    expect(clampEventTime(new Date('2026-11-01T00:00:00Z'), now)).toBeNull();
    const ok = new Date('2026-11-05T00:00:00Z');
    expect(clampEventTime(ok, now)).toEqual(ok);
  });

  it('retry backoff ends after the last attempt', () => {
    expect(nextRetryDelayMs(1)).toBe(5 * 60_000);
    expect(nextRetryDelayMs(5)).toBe(24 * 60 * 60_000);
    expect(nextRetryDelayMs(6)).toBeNull();
  });
});

describe('quote documents and buttons', () => {
  it('detects quotations by filename or caption', () => {
    expect(isQuoteDocument('Cotización 123.pdf')).toBe(true);
    expect(isQuoteDocument('doc.pdf', 'Te envío la proforma')).toBe(true);
    expect(isQuoteDocument('catalogo.pdf', 'Nuestro catálogo')).toBe(false);
  });

  it('finds the event configured on the tapped button or list row', () => {
    const buttons = {
      kind: 'buttons',
      body: 'x',
      buttons: [
        { id: 'a', title: 'A', meta_event: 'QualifiedLead' },
        { id: 'b', title: 'B' },
        { id: 'c', title: 'C', meta_event: 'Bogus' },
      ],
    };
    expect(buttonMetaEvent(buttons, 'a')).toBe('QualifiedLead');
    expect(buttonMetaEvent(buttons, 'b')).toBeNull();
    expect(buttonMetaEvent(buttons, 'c')).toBeNull();
    expect(buttonMetaEvent(buttons, 'zz')).toBeNull();
    const list = {
      kind: 'list',
      sections: [{ rows: [{ id: 'r1', title: 'R', meta_event: 'AddToCart' }] }],
    };
    expect(buttonMetaEvent(list, 'r1')).toBe('AddToCart');
    expect(buttonMetaEvent(null, 'r1')).toBeNull();
  });

  it('interactive validation accepts known events and rejects unknown ones', () => {
    const p = (meta_event?: string) => ({
      kind: 'buttons',
      body: 'Hola',
      buttons: [{ id: 'a', title: 'A', meta_event }],
    });
    expect(validateInteractivePayload(p()).ok).toBe(true);
    expect(validateInteractivePayload(p('InitiateCheckout')).ok).toBe(true);
    expect(validateInteractivePayload(p('Nope')).ok).toBe(false);
  });

  it('every event has a label in each locale', () => {
    for (const msgs of [es, en, ko]) {
      for (const n of META_CAPI_EVENT_NAMES) {
        expect(isMetaCapiEventName(n)).toBe(true);
        expect((msgs.MetaCapi.events as Record<string, string>)[n]).toBeTruthy();
      }
    }
    expect(isMetaCapiEventName('Lead')).toBe(false);
  });
});

describe('ventas feed', () => {
  it('parses amounts in common formats', () => {
    expect(parseMonto('S/ 1,234.50')).toBe(1234.5);
    expect(parseMonto('S/. 980.00')).toBe(980);
    expect(parseMonto('1234,5')).toBe(1234.5);
    expect(parseMonto('12,000')).toBe(12000);
    expect(parseMonto(800)).toBe(800);
    expect(parseMonto('')).toBeNull();
    expect(parseMonto('0')).toBeNull();
    expect(parseMonto(null)).toBeNull();
  });

  it('normalizes phones and drops rows without project', () => {
    const items = parseVentasResponse({
      linea: 'INOX',
      items: [
        { celular: '929564362', estado: 'CERRADO', monto_venta: '1500', project_id: 7, fecha: '2026-11-08 10:00:00' },
        { celular: '51911111111', estado: 'CERRADO', monto_venta: null, project_id: '8', fecha: null },
        { celular: '51922222222', estado: 'CERRADO', monto_venta: '10' },
      ],
    });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ celular: '51929564362', projectId: '7', monto: 1500 });
    expect(items[0].fecha?.getFullYear()).toBe(2026);
    expect(items[1]).toMatchObject({ celular: '51911111111', projectId: '8', monto: null, fecha: null });
    expect(() => parseVentasResponse({})).toThrow();
  });

  it('reads XLR8 dates as Lima time; a bare date is noon in Lima', () => {
    expect(parseXlr8Fecha('2026-11-08')?.toISOString()).toBe('2026-11-08T17:00:00.000Z');
    expect(parseXlr8Fecha('2026-11-08 10:30:00')?.toISOString()).toBe('2026-11-08T15:30:00.000Z');
    expect(parseXlr8Fecha('08/11/2026')).toBeNull();
    expect(parseXlr8Fecha(null)).toBeNull();
  });
});

describe('Purchase waiting for its amount', () => {
  const venta = (monto: number | null) => ({ celular: '51900000000', projectId: '7', monto, fecha: null });
  const now = new Date('2026-11-09T12:00:00Z');

  it('deadline is 48 h after the event, never past Meta’s 7 days', () => {
    const t = new Date('2026-11-09T00:00:00Z');
    expect(purchaseValueDeadline(t).toISOString()).toBe('2026-11-11T00:00:00.000Z');
    const old = new Date('2026-11-03T00:00:00Z');
    expect(purchaseValueDeadline(old).getTime()).toBeLessThan(old.getTime() + 7 * 86_400_000);
    // Backfilled closure: its wait is already over when it is recorded.
    expect(purchaseValueDeadline(new Date('2026-11-03T13:59:00Z')).getTime()).toBeLessThan(
      new Date('2026-11-09T21:12:00Z').getTime(),
    );
  });

  it('sends with value as soon as the amount shows up', () => {
    const deadline = new Date('2026-11-10T00:00:00Z');
    expect(decideAwaitingPurchase({ venta: venta(1500), ventasConfigured: true, deadline, now })).toBe('with_value');
    expect(decideAwaitingPurchase({ venta: venta(null), ventasConfigured: true, deadline, now })).toBe('wait');
    expect(decideAwaitingPurchase({ venta: null, ventasConfigured: true, deadline, now })).toBe('wait');
  });

  it('sends without value after the deadline or without a sales feed', () => {
    const past = new Date('2026-11-09T11:00:00Z');
    expect(decideAwaitingPurchase({ venta: null, ventasConfigured: true, deadline: past, now })).toBe('without_value');
    expect(decideAwaitingPurchase({ venta: venta(null), ventasConfigured: true, deadline: past, now })).toBe('without_value');
    expect(decideAwaitingPurchase({ venta: null, ventasConfigured: false, deadline: now, now })).toBe('without_value');
  });
});

describe('dataset name', () => {
  it('reads the env; unset or blank → no name', () => {
    expect(datasetNameFromEnv(' XLR9 Inox ')).toBe('XLR9 Inox');
    expect(datasetNameFromEnv('')).toBeNull();
    expect(datasetNameFromEnv(undefined)).toBeNull();
  });

  it('sends the name on create only when configured', () => {
    expect(datasetCreateBody('XLR9 Inox')).toEqual({ dataset_name: 'XLR9 Inox' });
    expect(datasetCreateBody(null)).toBeNull();
  });

  it('renames only when the name differs', () => {
    expect(datasetRenameNeeded('Dataset 123', 'XLR9 Inox')).toBe(true);
    expect(datasetRenameNeeded(null, 'XLR9 Inox')).toBe(true);
    expect(datasetRenameNeeded('XLR9 Inox', 'XLR9 Inox')).toBe(false);
    expect(datasetRenameNeeded('Dataset 123', null)).toBe(false);
  });
});
