import { AnalyticsModule } from '../analytics/analytics.module.js';
import { EventAuthModule } from '../event-auth/event-auth.module.js';
import { AnalyticsTenantController } from './controller/analytics-tenant.controller.js';
import { SupportContextController } from './controller/support-context.controller.js';
import { InvitationUploadController } from './controller/upload.controller.js';
import { GuestMutationResolver } from './resolver/guest-mutation.resolver.js';
import { AdminMutationResolver } from './resolver/invitation-admin-mutation.resolver.js';
import { InvitationFieldResolver } from './resolver/invitation-field.resolver.js';
import { InvitationQueryResolver } from './resolver/invitation-query.resolver.js';
import { GuestConfirmationService } from './service/guest-confirmation.service.js';
import { GuestWriteService } from './service/guest-write.service.js';
import { AdminWriteService } from './service/invitation-admin.write.service.js';
import { InvitationPreviewService } from './service/invitation-preview.service.js';
import { InvitationReadService } from './service/invitation-read.service.js';
import { InvitationWriteService } from './service/invitation-write.service.js';
import { LoaderFactory } from './utils/loader.factory.js';
import { PhoneNumberLoader } from './utils/phone-number.loader.js';
import { Module } from '@nestjs/common';

@Module({
  imports: [EventAuthModule, AnalyticsModule],
  controllers: [InvitationUploadController, AnalyticsTenantController, SupportContextController],
  providers: [
    InvitationQueryResolver,
    AdminMutationResolver,
    InvitationReadService,
    AdminWriteService,
    GuestWriteService,
    InvitationWriteService,
    GuestMutationResolver,
    InvitationFieldResolver,
    PhoneNumberLoader,
    LoaderFactory,
    InvitationPreviewService,
    GuestConfirmationService,
  ],
  exports: [
    InvitationReadService,
    AdminWriteService,
    InvitationWriteService,
    GuestWriteService,
    GuestConfirmationService,
  ],
})
export class InvitationModule {}
