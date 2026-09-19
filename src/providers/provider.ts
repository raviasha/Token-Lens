import { ProviderCapabilities } from '../core/contracts';

export interface CodeBuddyProvider {
  readonly capabilities: ProviderCapabilities;
}

export class CopilotVsCodeProvider implements CodeBuddyProvider {
  public readonly capabilities: ProviderCapabilities = {
    providerId: 'github-copilot-vscode',
    conversationEventAccess: 'hook',
    nativeContextMeasurement: false,
    visionContextMeasurement: false,
    toolInvocation: true,
    interactiveQuickPick: true,
    automaticNewChatSeed: false
  };
}
