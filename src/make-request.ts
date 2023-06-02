import * as node from '@api3/airnode-node';
import * as abi from '@api3/airnode-abi';
import { go } from '@api3/promise-utils';
import { ethers } from 'ethers';
import { logger } from './logging';
import { SignedData, signedDataSchema, Template } from './validation';
import { Id, getState } from './state';

export const urlJoin = (baseUrl: string, endpointId: string) => {
  if (baseUrl.endsWith('/')) {
    return `${baseUrl}${endpointId}`;
  } else {
    return `${baseUrl}/${endpointId}`;
  }
};

export function signWithTemplateId(templateId: string, timestamp: string, data: string) {
  const { airseekerWalletPrivateKey } = getState();

  return new ethers.Wallet(airseekerWalletPrivateKey).signMessage(
    ethers.utils.arrayify(
      ethers.utils.keccak256(
        ethers.utils.solidityPack(['bytes32', 'uint256', 'bytes'], [templateId, timestamp, data || '0x'])
      )
    )
  );
}

export const makeApiRequest = async (template: Id<Template>): Promise<SignedData> => {
  const {
    config: { endpoints, ois, apiCredentials },
    apiLimiters,
  } = getState();
  const logOptionsTemplateId = { meta: { 'Template-ID': template.id } };

  const parameters = abi.decode(template.parameters);
  const endpoint = endpoints[template.endpointId];

  const aggregatedApiCall: node.BaseAggregatedApiCall = {
    parameters,
    ...endpoint,
  };

  const limiter = apiLimiters[template.id];

  const [_, apiCallResponse] = await limiter.schedule({ expiration: 90_000 }, () =>
    node.api.callApi({
      type: 'http-gateway',
      config: { ois, apiCredentials },
      aggregatedApiCall,
    })
  );

  if (!apiCallResponse.success) {
    const message = `Failed to make direct API request for the endpoint [${endpoint.oisTitle}] ${endpoint.endpointName}.`;
    logger.warn(message, logOptionsTemplateId);
    throw new Error(message);
  }

  const encodedValue = (apiCallResponse as node.HttpGatewayApiCallSuccessResponse).data.encodedValue;
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const goSignWithTemplateId = await go(() => signWithTemplateId(template.id, timestamp, encodedValue));

  if (!goSignWithTemplateId.success) {
    const message = `Failed to sign data while making direct API request for the endpoint [${endpoint.oisTitle}] ${endpoint.endpointName}. Error: "${goSignWithTemplateId.error}"`;
    logger.warn(message, logOptionsTemplateId);
    throw new Error(message);
  }

  return {
    timestamp: timestamp,
    encodedValue: encodedValue,
    signature: goSignWithTemplateId.data,
  };
};
