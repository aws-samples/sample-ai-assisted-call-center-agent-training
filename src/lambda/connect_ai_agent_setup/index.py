"""
Custom Resource handler for Q Connect AI Prompt + AI Agent setup.

Called by CloudFormation to provision (and tear down) the AI Prompt + AI Agent
under a Wisdom (Q Connect) Assistant. Also handles WISDOM_ASSISTANT integration
association with the Connect instance and security profile association with the
created AI Agent.

ResourceProperties:
  AssistantId            — Wisdom assistant UUID
  ConnectInstanceId      — Connect instance UUID (no arn)
  Region, AccountId      — for ARN construction
  PromptContent          — YAML MESSAGES format prompt text
  AgentName              — friendly name for the AI Agent
  PromptName             — friendly name for the AI Prompt
  ModelId                — Bedrock model id for orchestration prompt
  Locale                 — e.g., en_US
  SecurityProfileId      — Connect AI-Agent security profile
  IntegrationAssociate   — "true" to create WISDOM_ASSISTANT integration
"""

import json
import logging
import time
import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def find_prompt(qc, assistant_id, name):
    try:
        paginator = qc.get_paginator('list_ai_prompts')
        for page in paginator.paginate(assistantId=assistant_id):
            for p in page.get('aiPromptSummaries', []):
                if p.get('name') == name:
                    return p
    except qc.exceptions.ResourceNotFoundException:
        logger.warning(f'Assistant {assistant_id} not found when listing prompts')
    return None


def find_agent(qc, assistant_id, name):
    try:
        paginator = qc.get_paginator('list_ai_agents')
        for page in paginator.paginate(assistantId=assistant_id):
            for a in page.get('aiAgentSummaries', []):
                if a.get('name') == name:
                    return a
    except qc.exceptions.ResourceNotFoundException:
        logger.warning(f'Assistant {assistant_id} not found when listing agents')
    return None


def list_wisdom_integrations(connect_client, instance_id):
    resp = connect_client.list_integration_associations(
        InstanceId=instance_id,
        IntegrationType='WISDOM_ASSISTANT',
    )
    return resp.get('IntegrationAssociationSummaryList', [])


def find_integration(connect_client, instance_id, integration_arn):
    for item in list_wisdom_integrations(connect_client, instance_id):
        if item.get('IntegrationArn') == integration_arn:
            return item
    return None


def cleanup_stale_integrations(connect_client, instance_id, keep_arn):
    """Delete any WISDOM_ASSISTANT integrations that don't point to keep_arn.
    Connect enforces a 1-per-instance limit; stale orphans from failed prior
    deploys block new integrations until cleaned up.
    """
    for item in list_wisdom_integrations(connect_client, instance_id):
        if item.get('IntegrationArn') != keep_arn:
            try:
                logger.info(f'Deleting stale WISDOM_ASSISTANT integration {item["IntegrationAssociationId"]} -> {item["IntegrationArn"]}')
                connect_client.delete_integration_association(
                    InstanceId=instance_id,
                    IntegrationAssociationId=item['IntegrationAssociationId'],
                )
            except Exception as e:
                logger.warning(f'Delete stale integration failed: {e}')


def ensure_assistant_tagged(assistant_arn):
    """Connect validates the AmazonConnectEnabled=True tag via service-side
    permissions when creating a WISDOM_ASSISTANT integration. Re-tag explicitly
    from the Lambda context to avoid timing / propagation races with CfnAssistant.tags.
    """
    for client_name in ('wisdom', 'qconnect'):
        try:
            client = boto3.client(client_name)
            client.tag_resource(
                resourceArn=assistant_arn,
                tags={'AmazonConnectEnabled': 'True'},
            )
            logger.info(f'Tagged assistant via {client_name}: AmazonConnectEnabled=True')
            return
        except Exception as e:
            logger.warning(f'{client_name}:tag_resource failed: {e}')


def upsert_integration(connect_client, instance_id, assistant_arn):
    existing = find_integration(connect_client, instance_id, assistant_arn)
    if existing:
        logger.info(f'Integration already exists: {existing["IntegrationAssociationId"]}')
        return existing['IntegrationAssociationId']

    # Clean up stale integrations from previous failed deploys (Connect limits
    # WISDOM_ASSISTANT integrations to 1 per instance).
    cleanup_stale_integrations(connect_client, instance_id, assistant_arn)

    ensure_assistant_tagged(assistant_arn)

    # Connect's validation is eventually consistent — retry a few times.
    last_err = None
    for attempt in range(6):
        try:
            resp = connect_client.create_integration_association(
                InstanceId=instance_id,
                IntegrationType='WISDOM_ASSISTANT',
                IntegrationArn=assistant_arn,
            )
            logger.info(f'Created integration: {resp["IntegrationAssociationId"]}')
            return resp['IntegrationAssociationId']
        except Exception as e:
            last_err = e
            logger.warning(f'CreateIntegrationAssociation attempt {attempt + 1} failed: {e}')
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f'CreateIntegrationAssociation failed after retries: {last_err}')


def upsert_prompt(qc, assistant_id, name, description, model_id, content):
    existing = find_prompt(qc, assistant_id, name)
    if existing:
        prompt_id = existing['aiPromptId']
        logger.info(f'Reusing prompt {name} ({prompt_id})')
    else:
        resp = qc.create_ai_prompt(
            assistantId=assistant_id,
            name=name,
            type='ORCHESTRATION',
            description=description,
            templateType='TEXT',
            templateConfiguration={
                'textFullAIPromptEditTemplateConfiguration': {'text': content},
            },
            modelId=model_id,
            apiFormat='MESSAGES',
            visibilityStatus='PUBLISHED',
        )
        prompt_id = resp['aiPrompt']['aiPromptId']
        logger.info(f'Created prompt {name} ({prompt_id})')

    version_resp = qc.create_ai_prompt_version(assistantId=assistant_id, aiPromptId=prompt_id)
    version_num = version_resp.get('aiPrompt', {}).get('versionNumber', 1)
    return prompt_id, f'{prompt_id}:{version_num}'


def upsert_agent(qc, assistant_id, name, description, prompt_version_qualified_id, connect_instance_arn, locale):
    existing = find_agent(qc, assistant_id, name)
    if existing:
        logger.info(f'Deleting existing agent {name} ({existing["aiAgentId"]}) to recreate')
        delete_agent(qc, assistant_id, existing['aiAgentId'])
        time.sleep(2)

    agent_config = {
        'orchestrationAIAgentConfiguration': {
            'orchestrationAIPromptId': prompt_version_qualified_id,
            'connectInstanceArn': connect_instance_arn,
            'locale': locale,
            'toolConfigurations': [],
        }
    }
    resp = qc.create_ai_agent(
        assistantId=assistant_id,
        name=name,
        type='ORCHESTRATION',
        description=description,
        configuration=agent_config,
        visibilityStatus='PUBLISHED',
    )
    agent_id = resp['aiAgent']['aiAgentId']
    logger.info(f'Created agent {name} ({agent_id})')

    version_resp = qc.create_ai_agent_version(assistantId=assistant_id, aiAgentId=agent_id)
    version_num = version_resp.get('aiAgent', {}).get('versionNumber', 1)
    return agent_id, version_num


def associate_security_profile(connect_client, instance_id, security_profile_id, agent_arns):
    for arn in agent_arns:
        try:
            connect_client.associate_security_profiles(
                InstanceId=instance_id,
                EntityType='AI_AGENT',
                EntityArn=arn,
                SecurityProfiles=[{'Id': security_profile_id}],
            )
            logger.info(f'Associated security profile with {arn}')
        except Exception as e:
            logger.warning(f'Security profile associate failed for {arn}: {e}')


def disassociate_security_profiles(connect_client, instance_id, agent_arn):
    try:
        resp = connect_client.list_entity_security_profiles(
            InstanceId=instance_id,
            EntityArn=agent_arn,
            EntityType='AI_AGENT',
        )
        items = resp.get('SecurityProfileItems', [])
        if items:
            connect_client.disassociate_security_profiles(
                InstanceId=instance_id,
                EntityArn=agent_arn,
                EntityType='AI_AGENT',
                SecurityProfiles=[{'Id': sp['Id']} for sp in items],
            )
    except Exception as e:
        logger.warning(f'Security profile disassociate failed for {agent_arn}: {e}')


def delete_agent(qc, assistant_id, agent_id):
    try:
        versions = qc.list_ai_agent_versions(assistantId=assistant_id, aiAgentId=agent_id)
        for v in versions.get('aiAgentVersionSummaries', []):
            vn = v.get('versionNumber')
            if vn and vn != 'DRAFT':
                try:
                    qc.delete_ai_agent(assistantId=assistant_id, aiAgentId=f'{agent_id}:{vn}')
                except Exception as e:
                    logger.warning(f'Delete agent version {vn} failed: {e}')
        qc.delete_ai_agent(assistantId=assistant_id, aiAgentId=agent_id)
    except Exception as e:
        logger.warning(f'Delete agent {agent_id} failed: {e}')


def delete_prompt(qc, assistant_id, prompt_id):
    try:
        versions = qc.list_ai_prompt_versions(assistantId=assistant_id, aiPromptId=prompt_id)
        for v in versions.get('aiPromptVersionSummaries', []):
            vn = v.get('versionNumber')
            if vn and vn != 'DRAFT':
                try:
                    qc.delete_ai_prompt(assistantId=assistant_id, aiPromptId=f'{prompt_id}:{vn}')
                except Exception as e:
                    logger.warning(f'Delete prompt version {vn} failed: {e}')
        qc.delete_ai_prompt(assistantId=assistant_id, aiPromptId=prompt_id)
    except Exception as e:
        logger.warning(f'Delete prompt {prompt_id} failed: {e}')


def handle_create_or_update(event):
    props = event['ResourceProperties']
    assistant_id = props['AssistantId']
    connect_instance_id = props['ConnectInstanceId']
    region = props['Region']
    account_id = props['AccountId']
    prompt_content = props['PromptContent']
    agent_name = props['AgentName']
    prompt_name = props['PromptName']
    model_id = props['ModelId']
    locale = props.get('Locale', 'en_US')
    security_profile_id = props.get('SecurityProfileId')
    integration_associate = props.get('IntegrationAssociate', 'true').lower() == 'true'

    qc = boto3.client('qconnect')
    connect_client = boto3.client('connect')

    connect_instance_arn = f'arn:aws:connect:{region}:{account_id}:instance/{connect_instance_id}'
    assistant_arn = f'arn:aws:wisdom:{region}:{account_id}:assistant/{assistant_id}'

    integration_id = None
    if integration_associate:
        integration_id = upsert_integration(connect_client, connect_instance_id, assistant_arn)

    prompt_id, prompt_version_id = upsert_prompt(
        qc, assistant_id, prompt_name,
        f'Orchestration prompt for {agent_name}',
        model_id, prompt_content,
    )

    agent_id, version_num = upsert_agent(
        qc, assistant_id, agent_name,
        f'Orchestration AI Agent for call center training ({agent_name})',
        prompt_version_id, connect_instance_arn, locale,
    )

    published_agent_version_arn = (
        f'arn:aws:wisdom:{region}:{account_id}:ai-agent/{assistant_id}/{agent_id}:{version_num}'
    )

    if security_profile_id:
        base_arn = f'arn:aws:wisdom:{region}:{account_id}:ai-agent/{assistant_id}/{agent_id}'
        associate_security_profile(
            connect_client, connect_instance_id, security_profile_id,
            [f'{base_arn}:$SAVED', f'{base_arn}:$LATEST', f'{base_arn}:{version_num}'],
        )

    return {
        'AssistantArn': assistant_arn,
        'AIPromptId': prompt_id,
        'AIPromptVersionId': prompt_version_id,
        'AIAgentId': agent_id,
        'AIAgentVersionNumber': str(version_num),
        'PublishedAIAgentVersionArn': published_agent_version_arn,
        'IntegrationAssociationId': integration_id or '',
    }


def handle_delete(event):
    props = event['ResourceProperties']
    assistant_id = props['AssistantId']
    connect_instance_id = props['ConnectInstanceId']
    region = props['Region']
    account_id = props['AccountId']
    agent_name = props['AgentName']
    prompt_name = props['PromptName']

    qc = boto3.client('qconnect')
    connect_client = boto3.client('connect')
    assistant_arn = f'arn:aws:wisdom:{region}:{account_id}:assistant/{assistant_id}'

    existing_agent = find_agent(qc, assistant_id, agent_name)
    if existing_agent:
        agent_id = existing_agent['aiAgentId']
        base_arn = f'arn:aws:wisdom:{region}:{account_id}:ai-agent/{assistant_id}/{agent_id}'
        for suffix in ['', ':$SAVED', ':$LATEST']:
            disassociate_security_profiles(connect_client, connect_instance_id, f'{base_arn}{suffix}')
        delete_agent(qc, assistant_id, agent_id)

    existing_prompt = find_prompt(qc, assistant_id, prompt_name)
    if existing_prompt:
        delete_prompt(qc, assistant_id, existing_prompt['aiPromptId'])

    try:
        existing_integration = find_integration(connect_client, connect_instance_id, assistant_arn)
        if existing_integration:
            try:
                connect_client.delete_integration_association(
                    InstanceId=connect_instance_id,
                    IntegrationAssociationId=existing_integration['IntegrationAssociationId'],
                )
            except Exception as e:
                logger.warning(f'Delete integration failed: {e}')
    except Exception as e:
        logger.warning(f'Lookup integration during delete failed (non-fatal): {e}')

    return {}


def handler(event, context):
    """Provider framework handler — return a dict with PhysicalResourceId and Data.
    The wrapping cr.Provider Lambda posts the response to CloudFormation for us.
    """
    logger.info(f'Event: {json.dumps(event, default=str)}')
    request_type = event.get('RequestType', '')
    phys_id = event.get('PhysicalResourceId') or f'connect-ai-agent-{context.aws_request_id}'

    if request_type in ('Create', 'Update'):
        data = handle_create_or_update(event)
    elif request_type == 'Delete':
        data = handle_delete(event)
    else:
        raise ValueError(f'Unknown RequestType: {request_type}')

    return {
        'PhysicalResourceId': phys_id,
        'Data': data,
    }
