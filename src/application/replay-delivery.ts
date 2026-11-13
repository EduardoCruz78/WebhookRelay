import type { Clock } from '../domain/clock.js';
import { replay, type Delivery } from '../domain/delivery.js';
import { err, ok, type DomainError, type Result } from '../domain/result.js';
import type { UnitOfWork } from './ports.js';

export const DeliveryNotFound: DomainError = {
  code: 'Delivery.NotFound',
  message: 'Delivery not found.',
  type: 'not_found',
};

const ReplayConflict: DomainError = {
  code: 'Delivery.ReplayConflict',
  message: 'The delivery changed while it was being replayed; try again.',
  type: 'conflict',
};

/** D6: sends a dead delivery again, with a fresh retry budget. The job commits with the new state. */
export async function replayDelivery(
  id: string,
  deps: { unitOfWork: UnitOfWork; clock: Clock },
): Promise<Result<Delivery>> {
  const now = deps.clock.now();
  return deps.unitOfWork.run(async ({ repositories, queue }) => {
    const delivery = await repositories.deliveries.findById(id);
    if (!delivery) return err(DeliveryNotFound);

    const replayed = replay(delivery, now);
    if (!replayed.ok) return replayed;

    const saved = await repositories.deliveries.update(replayed.value, {
      status: delivery.status,
      attempts: delivery.attempts,
    });
    if (!saved) return err(ReplayConflict);
    await queue.enqueue([{ deliveryId: id, runAt: now }]);
    return ok(replayed.value);
  });
}
