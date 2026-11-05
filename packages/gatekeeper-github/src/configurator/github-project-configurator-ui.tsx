import { Field, h, HierarchyPicker, RadioCards, Section, TextInput, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { GitHubProjectConfiguratorRpc, GitHubProjectConfiguratorValues } from "./github-project-configurator-types";

const ORG = "https://github.com/orgs/:owner/projects/:number";
const USER = "https://github.com/users/:owner/projects/:number";

export default {
  initial: { ownerType: "organization" },
  isReady({ values, acceptedResourceUrlPatterns }) {
    const match = /^https:\/\/github\.com\/(orgs|users)\/([A-Za-z0-9][A-Za-z0-9-]*)\/projects\/([1-9]\d*)$/.exec(values.projectUrl ?? "");
    return !!match && (!acceptedResourceUrlPatterns || acceptedResourceUrlPatterns.includes(match[1] === "orgs" ? ORG : USER));
  },
  initialValuesFromResourceUrl({ resourceUrl, resourceUrlPattern }) {
    const [, family, owner, , number] = new URL(resourceUrl).pathname.split("/");
    return { owner, ownerType: family === "users" || resourceUrlPattern === USER ? "user" : "organization",
      projectUrl: `https://github.com/${family}/${owner}/projects/${number}` };
  },
  resourceUrl({ values }) { return values.projectUrl!; },
  render({ values, setValues, ui, acceptedResourceUrlPatterns }) {
    const ownerType = values.ownerType === "user" ? "user" : "organization";
    const options = [
      { value: "organization", title: "Organization", description: "Projects owned by an organization", pattern: ORG },
      { value: "user", title: "User", description: "Projects owned by a user", pattern: USER },
    ].filter(option => !acceptedResourceUrlPatterns || acceptedResourceUrlPatterns.includes(option.pattern));
    const selectedType = options.find(option => option.value === ownerType)?.value ?? options[0]?.value;
    const effectiveType = selectedType === "user" ? "user" : "organization";
    return <Section>
      <Field label="Project owner">
        <RadioCards value={effectiveType} options={options}
          onChange={nextType => setValues({ ownerType: nextType, projectUrl: null })} />
      </Field>
      <Field label="Organization or user login" description="Browse projects visible to your GitHub account.">
        <TextInput name="owner" value={values.owner} placeholder="GitHub login..."
          onChange={owner => setValues({ owner, projectUrl: null })} />
      </Field>
      {values.owner && <Field label="Project" description="Connect one project, including its draft and archived items.">
        <HierarchyPicker name="projectUrl" value={values.projectUrl}
          root={{ id: `${effectiveType}/${values.owner}`, title: "Projects", selectable: false }}
          loadItems={({ cursor }) => ui.listProjects(effectiveType, values.owner!, cursor)}
          loadItem={id => ui.getProject(id)}
          onChange={projectUrl => setValues({ projectUrl })} />
      </Field>}
    </Section>;
  },
} satisfies ConfiguratorUISpec<GitHubProjectConfiguratorRpc, GitHubProjectConfiguratorValues>;
