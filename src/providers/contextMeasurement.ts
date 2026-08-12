import {
  CodeBuddyPolicy,
  ContextEstimate,
  ContextMeasurementCandidate,
  ContextMeasurementInput,
  ContextMeasurementMethod,
  ContextMeasurementResult,
  TOOL_CONTRACT_VERSION,
  ToolFailure
} from '../core/contracts';
import { classifyContext } from '../core/policyEngine';

export interface MeasurementResolution {
  method: ContextMeasurementMethod;
  providerId: string;
  candidate: ContextMeasurementCandidate | NonNullable<ContextMeasurementInput['estimate']>;
}

export interface ContextMeasurementProvider {
  readonly method: ContextMeasurementMethod;
  resolve(input: ContextMeasurementInput, policy: CodeBuddyPolicy): MeasurementResolution | undefined;
}

export class NativeInputMeasurementProvider implements ContextMeasurementProvider {
  public readonly method = 'api' as const;
  public resolve(input: ContextMeasurementInput): MeasurementResolution | undefined {
    return input.nativeMeasurement
      ? { method: this.method, providerId: input.nativeMeasurement.providerId, candidate: input.nativeMeasurement }
      : undefined;
  }
}

export class VisionInputMeasurementProvider implements ContextMeasurementProvider {
  public readonly method = 'vision' as const;
  public resolve(input: ContextMeasurementInput, policy: CodeBuddyPolicy): MeasurementResolution | undefined {
    return policy.context.allowVisionVerification && input.visionMeasurement
      ? { method: this.method, providerId: input.visionMeasurement.providerId, candidate: input.visionMeasurement }
      : undefined;
  }
}

export class EstimateMeasurementProvider implements ContextMeasurementProvider {
  public readonly method = 'estimate' as const;
  public resolve(input: ContextMeasurementInput): MeasurementResolution | undefined {
    return input.estimate
      ? { method: this.method, providerId: 'code-buddy-estimator', candidate: input.estimate }
      : undefined;
  }
}

export class ContextMeasurementService {
  public constructor(
    private readonly policy: CodeBuddyPolicy,
    private readonly providers: ContextMeasurementProvider[] = [
      new NativeInputMeasurementProvider(),
      new VisionInputMeasurementProvider(),
      new EstimateMeasurementProvider()
    ]
  ) {}

  public measure(input: ContextMeasurementInput): ContextMeasurementResult {
    const resolution = this.providers.map((provider) => provider.resolve(input, this.policy)).find(Boolean);
    if (!resolution) {
      const failure: ToolFailure = {
        code: 'provider_unavailable',
        message: 'No native, vision, or Code Buddy estimate was available.',
        continuation: 'use_estimate'
      };
      return {
        contractVersion: TOOL_CONTRACT_VERSION,
        kind: 'context_measurement',
        status: 'fallback',
        measurement: {
          value: 0,
          unit: 'estimated_tokens',
          method: 'estimate',
          confidence: 'low',
          thresholdState: 'normal',
          terminology: 'Estimated Context Pressure'
        },
        providerId: 'unavailable',
        recommendation: 'none',
        availableActions: ['continue_unchanged'],
        failure
      };
    }
    const candidate = resolution.candidate;
    const utilization = 'utilization' in candidate && typeof candidate.utilization === 'number'
      ? candidate.utilization
      : candidate.value / Math.max(1, this.policy.context.estimatedContextCapacityTokens);
    const thresholdState = classifyContext(utilization, this.policy);
    const actual = resolution.method === 'api';
    const measurement: ContextEstimate = {
      value: Math.max(0, Math.round(candidate.value)),
      unit: actual ? 'tokens' : 'estimated_tokens',
      utilization,
      method: resolution.method,
      confidence: candidate.confidence,
      thresholdState,
      ...('estimatorVersion' in candidate && candidate.estimatorVersion ? { estimatorVersion: candidate.estimatorVersion } : {}),
      terminology: actual ? 'Actual Context Utilization' : 'Estimated Context Pressure'
    };
    return {
      contractVersion: TOOL_CONTRACT_VERSION,
      kind: 'context_measurement',
      status: 'ok',
      measurement,
      providerId: resolution.providerId,
      recommendation: thresholdState === 'critical' ? 'curate_or_start_fresh' : thresholdState === 'warning' ? 'consider_curation' : 'none',
      availableActions: thresholdState === 'normal'
        ? ['continue_unchanged']
        : ['start_fresh', 'curate_current', 'continue_unchanged']
    };
  }
}
