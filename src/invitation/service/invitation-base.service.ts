import type { Invitation } from '../../prisma/generated/client.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { InvitationNotFoundException } from '../errors/invitation-domain.error.js';
import type { OmnixysLogger, ScopedLogger } from '@omnixys/logger-ts';
import { TraceRunner } from '@omnixys/observability-ts';

/**
 * Shared base class for invitation read/write services.
 *  - OTel-Span-Helfer
 *  - Hilfsfunktionen (z. B. Rollen auflösen)
 *
 *  Keine Business-Methoden – nur shared Infrastruktur.
 */
export abstract class InvitationBaseService {
  /** OpenTelemetry tracer instance. */

  /** Logger service wrapper. */
  protected readonly loggerPlusService: OmnixysLogger;

  /** Local logger instance. */
  protected readonly logger: ScopedLogger;

  protected readonly prismaService: PrismaService;

  protected constructor(loggerPlusService: OmnixysLogger, prismaService: PrismaService) {
    this.loggerPlusService = loggerPlusService;
    this.logger = loggerPlusService.log(this.constructor.name, 'service:invitation');
    this.prismaService = prismaService;
  }

  protected async ensureExists(id: string): Promise<Invitation> {
    return TraceRunner.run('[SERVICE] ensureExists', async () => {
      const found = await this.prismaService.invitation.findUnique({
        where: { id },
        include: {
          phoneNumbers: true,
        },
      });

      if (!found) {
        this.logger.error('Invitation not found: %s', id);
        throw new InvitationNotFoundException(id);
      }
      return found;
    });
  }
}
