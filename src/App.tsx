import { HashRouter, Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import HomePage from './pages/Home'
import GoalsPage from './pages/Goals'
import WorkPage from './pages/Work'
import ProjectsPage from './pages/Projects'
import ActionsPage from './pages/Actions'
import GrowthPage from './pages/Growth'
import KnowledgePage from './pages/Knowledge'
import MemoryPage from './pages/MemoryPage'
import LifePage from './pages/Life'
import AICenterPage from './pages/AICenter'
import SettingsPage from './pages/Settings'
import ContextInspector from './pages/ContextInspector'
import AgentsPage from './pages/AgentsPage'
import WorkflowsPage from './pages/WorkflowsPage'
import IntegrationsPage from './pages/IntegrationsPage'
import AiLabPage from './pages/AiLabPage'
import SystemPage from './pages/SystemPage'
import SyncPage from './pages/SyncPage'
import InboxPage from './pages/InboxPage'
import AttachmentsPage from './pages/AttachmentsPage'
import DailyLogPage from './pages/DailyLog'
import StatsPage from './pages/Stats'
import AIReviewPage from './pages/AIReview'
import FilesPage from './pages/FilesPage'
import CustomersPage from './pages/CustomersPage'
import FollowUpsPage from './pages/FollowUpsPage'
import EmailGraphPage from './pages/EmailGraph'
import EmailPanoramaPage from './pages/EmailPanorama'
import CampaignsPage from './pages/CampaignsPage'
// 批量营销已并入跟进；保留模块文件，路由指向 FollowUps
void CampaignsPage

import { useEffect } from 'react'
import { initEmailSync } from './services/emailSyncService'

export default function App() {
  useEffect(()=>{ initEmailSync() },[])
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<HomePage />} />
          <Route path="inbox" element={<InboxPage />} />
          <Route path="attachments" element={<AttachmentsPage />} />
          <Route path="goals" element={<GoalsPage />} />
          <Route path="work" element={<WorkPage />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="actions" element={<ActionsPage />} />
          <Route path="growth" element={<GrowthPage />} />
          <Route path="knowledge" element={<KnowledgePage />} />
          <Route path="memory" element={<MemoryPage />} />
          <Route path="inspector" element={<ContextInspector />} />
          <Route path="life" element={<LifePage />} />
          <Route path="ai" element={<AICenterPage />} />
          <Route path="agents" element={<AgentsPage />} />
          <Route path="workflows" element={<WorkflowsPage />} />
          <Route path="integrations" element={<IntegrationsPage />} />
          <Route path="ai-lab" element={<AiLabPage />} />
          <Route path="system" element={<SystemPage />} />
          <Route path="sync" element={<SyncPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="journal" element={<DailyLogPage />} />
          <Route path="stats" element={<StatsPage />} />
          <Route path="review" element={<AIReviewPage />} />
          <Route path="files" element={<FilesPage />} />
          <Route path="customers" element={<CustomersPage />} />
          <Route path="followups" element={<FollowUpsPage />} />
          <Route path="campaigns" element={<FollowUpsPage />} />
          <Route path="graph" element={<EmailGraphPage />} />
          <Route path="panorama" element={<EmailPanoramaPage />} />
        </Route>
      </Routes>
    </HashRouter>
  )
}