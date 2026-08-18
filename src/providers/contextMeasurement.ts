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

export function formatContextHealthLineStatus(measurement: ContextEstimate, limitedEvidence = false): string {
  if (limitedEvidence) {
    return 'checked — limited evidence';
  }
  const state = measurement.thresholdState === 'unavailable' ? 'checked' : measurement.thresholdState;
  const value = measurement.value.toLocaleString('en-US');
  if (measurement.unit === 'tokens') {
    if (typeof measurement.utilization === 'number' && typeof measurement.capacityTokens === 'number') {
      const capacity = measurement.capacityTokens.toLocaleString('en-US');
      return `${state} — ${value} / ${capacity} tokens (${(measurement.utilization * 100).toFixed(1)}% actual)`;
    }
    return `${state} — ${value} actual tokens; percentage unavailable`;
  }
  if (typeof measurement.utilization === 'number') {
    return `${state} — ~${value} estimated tokens (${(measurement.utilization * 100).toFixed(1)}% estimated)`;
  }
  return `${state} — ~${value} estimated tokens`;
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
        healthLineStatus: 'checked — limited evidence',
        providerId: 'unavailable',
        recommendation: 'none',
        availableActions: ['continue_unchanged'],
        failure
      };
    }
    const candidate = resolution.candidate;
    const actual = resolution.method === 'api';
    const capacityTokens = 'capacityTokens' in candidate && typeof candidate.capacityTokens === 'number'
      ? candidate.capacityTokens
      : undefined;
    const utilization = 'utilization' in candidate && typeof candidate.utilization === 'number'
      ? candidate.utilization
      : actual
        ? capacityTokens ? candidate.value / Math.max(1, capacityTokens) : undefined
        : candidate.value / Math.max(1, this.policy.context.estimatedContextCapacityTokens);
    const thresholdState = utilization === undefined ? 'unavailable' : classifyContext(utilization, this.policy);
    const measurement: ContextEstimate = {
      value: Math.max(0, Math.round(candidate.value)),
      unit: actual ? 'tokens' : 'estimated_tokens',
      ...(utilization !== undefined ? { utilization } : {}),
      ...(capacityTokens !== undefined ? { capacityTokens } : {}),
      method: resolution.method,
      confidence: candidate.confidence,
      thresholdState,
      ...('estimatorVersion' in candidate && candidate.estimatorVersion ? { estimatorVersion: candidate.estimatorVersion } : {}),
      ...('measurementTimestamp' in candidate && candidate.measurementTimestamp ? { measurementTimestamp: candidate.measurementTimestamp } : {}),
      ...('cachedInputTokens' in candidate && typeof candidate.cachedInputTokens === 'number' ? { cachedInputTokens: candidate.cachedInputTokens } : {}),
      ...('cacheWriteInputTokens' in candidate && typeof candidate.cacheWriteInputTokens === 'number' ? { cacheWriteInputTokens: candidate.cacheWriteInputTokens } : {}),
      ...('outputTokens' in candidate && typeof candidate.outputTokens === 'number' ? { outputTokens: candidate.outputTokens } : {}),
      ...('reasoningTokens' in candidate && typeof candidate.reasoningTokens === 'number' ? { reasoningTokens: candidate.reasoningTokens } : {}),
      ...('totalTokens' in candidate && typeof candidate.totalTokens === 'number' ? { totalTokens: candidate.totalTokens } : {}),
      providerId: resolution.providerId,
      terminology: actual ? 'Actual Context Utilization' : 'Estimated Context Pressure'
    };
    return {
      contractVersion: TOOL_CONTRACT_VERSION,
      kind: 'context_measurement',
      status: 'ok',
      measurement,
      healthLineStatus: formatContextHealthLineStatus(measurement),
      providerId: resolution.providerId,
      recommendation: thresholdState === 'critical' ? 'curate_or_start_fresh' : thresholdState === 'warning' ? 'consider_curation' : 'none',
      availableActions: thresholdState === 'normal' || thresholdState === 'unavailable'
        ? ['continue_unchanged']
        : ['start_fresh', 'curate_current', 'continue_unchanged']
    };
  }
}
